"""The interviewer, as a Pipecat LLM service that calls the web tier instead of a model (design section 6).

The web owns the transcript, the prompt, the director and every Anthropic call: this service posts the
candidate's turn (the user aggregator's last message) to `/turns`, streams the reply's text into the pipeline
for the voice to speak, and keeps the state the web returns (stage, closed). While the first words are slow to
arrive it speaks a filler. When the candidate cuts in, the stream is dropped: the web keeps the exchange as far
as it got (their words, the start of the reply) so the next turn is answered at once, and `played` then tells
the web which words were actually heard.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings

from app.web_client import State, WebClient, WebError
from bot import speech
from bot.conductor import (
    PEN_TEXT,
    PauseFrame,
    PenMarkFrame,
    SegmentEndFrame,
    SegmentStartFrame,
    pause_after,
    pen_items,
)

# A word in a segment of speech, and what a segment may not open with (a drawing's sentence ends after it).
_WORD = re.compile(r"\w")
_LEAD = re.compile(r"^[\s.,;:!?…—–-]+")
# The space after a sentence's end, or after a colon: where a lesson's reply may pause (conductor.pause_after).
_BREAK = re.compile(r"(?<=[.!?:])\s+")


class GatewayLLMService(LLMService):
    def __init__(
        self,
        *,
        web: WebClient,
        sid: str,
        state: State,
        on_state: Callable[[State], Awaitable[None]],
        on_stale: Callable[[WebError], Awaitable[None]],
        spoken_text: Callable[[], str],
        filler_after_secs: float = 1.2,
        rng: random.Random | None = None,
        on_draw: Callable[..., Awaitable[None]] | None = None,
        pace_drawings: bool = False,
        playing: Callable[[], bool] | None = None,
        **kwargs,
    ):
        # The model, prompt and sampling live on the web: nothing here is a setting.
        kwargs.setdefault(
            "settings",
            LLMSettings(
                model="arrowbox-interview",
                system_instruction=None,
                temperature=None,
                max_tokens=None,
                top_p=None,
                top_k=None,
                frequency_penalty=None,
                presence_penalty=None,
                seed=None,
                filter_incomplete_user_turns=None,
                user_turn_completion_config=None,
            ),
        )
        super().__init__(**kwargs)
        self._web = web
        self._sid = sid
        self.state = state
        self._on_state = on_state
        self._on_stale = on_stale
        self._spoken_text = spoken_text
        # Whether the voice is still saying the last reply (its text may all be in long before its audio ends).
        self._playing = playing
        self._heard_sent = False  # the words heard of the current reply went to the web
        self._heard_task: asyncio.Task | None = None
        self._filler_after = filler_after_secs
        self._rng = rng or random.Random()
        # The board gets each drawing at once; with pace_drawings (a lesson) the voice then says each label as
        # the pen writes it (bot/conductor.py), and the drawing carries the reference its cues name.
        self._on_draw = on_draw
        self._pace = pace_drawings
        self._paced = 0
        self._pace_id = uuid.uuid4().hex[:6]  # a rejoin's pipeline names its drawings apart from the last one's
        # Turns go to the web one at a time, in sequence (a reply read to its end after an interruption).
        self._lock = asyncio.Lock()
        self._interrupted = False
        self._in_reply = False
        self._segment_said = False  # the current segment of speech has words (_turn, _draw)
        self._segment_lead = ""  # its opening, held until a word arrives
        self._ended = 0  # the words so far end at a break: the pause a lesson makes if a space follows (ms)
        self._piece = ""  # the words since the last pause, to size the next one
        self._turn_task: asyncio.Task | None = None
        self._stream: asyncio.Task | None = None  # the web call of the reply in flight
        self.turns = 0
        self.continues = 0
        self.failures = 0
        self.fillers = 0

    def can_generate_metrics(self) -> bool:
        return True

    @property
    def busy(self) -> bool:
        """A reply is in flight (a guess at the next turn would be on the wrong transcript)."""
        return self._in_reply

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, UserStartedSpeakingFrame):
            # When the learner starts talking, and whether the voice was talking then (a cut-in that did not stop
            # the voice shows here without an interruption after it).
            logger.info("voice learner speaking {} reply={} playing={}", self._sid, self._in_reply, self._is_playing())
            await self.push_frame(frame, direction)
        elif isinstance(frame, InterruptionFrame):
            logger.info("voice cut-in {} reply={} playing={}", self._sid, self._in_reply, self._is_playing())
            if self._in_reply:
                self._interrupted = True
                # The candidate cut in: the web keeps what has streamed and frees the session for the next turn.
                if self._stream and not self._stream.done():
                    self._stream.cancel()
            elif self._is_playing() and not self._heard_sent:
                # The reply's text was all in but the voice was still saying it: the web is told what was heard,
                # so the lesson knows the move was cut short (before the learner's turn is sent).
                self._heard_sent = True
                self._heard_task = self.create_task(self._send_heard(), name="heard")
            await self.push_frame(frame, direction)
        elif isinstance(frame, LLMContextFrame):
            if frame.speculation:
                return  # Pipecat's own speculative inference is not used (bot/speculate.py posts the guess)
            text = _last_user_text(frame.context)
            if text:
                # Pipecat cancels the frame task on an interruption; the turn runs in its own task so
                # the web still receives the whole exchange when the candidate cuts in.
                self._turn_task = self.create_task(self._turn(text), name="turn")
        elif isinstance(frame, EndFrame | CancelFrame):
            await self._settle(cancel=isinstance(frame, CancelFrame))
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def continue_lesson(self) -> None:
        """A coach lesson's next move (docs/coach-mode.md): a turn with no words from the learner,
        asked for by the idle clock's self-drive, or when the learner joins a lesson that has not opened."""
        self._turn_task = self.create_task(self._turn(None), name="continue")

    async def _settle(self, *, cancel: bool) -> None:
        task = self._turn_task
        self._turn_task = None
        if task is None or task.done():
            return
        if cancel:
            await self.cancel_task(task)
            return
        try:
            await asyncio.wait_for(task, timeout=30)
        except (TimeoutError, asyncio.CancelledError):
            await self.cancel_task(task)

    async def _turn(self, text: str | None) -> None:
        """The candidate's words answered, or (text None) a lesson's next move: a `continue` turn, which is not
        a candidate turn (the sequence stands) and gets no filler (nobody asked anything)."""
        spoken = text is not None
        kind = "speech" if spoken else "continue"
        if self._heard_task is not None:
            await self._heard_task
            self._heard_task = None
        async with self._lock:
            if self.state.closed:
                return
            self._interrupted = False
            self._heard_sent = False
            self._in_reply = True
            self._segment_said = False
            self._segment_lead = ""
            self._ended = 0
            self._piece = ""
            seq = self.state.seq + 1 if spoken else self.state.seq
            started = time.monotonic()
            first = asyncio.Event()
            filler = asyncio.create_task(self._filler(first)) if spoken else None
            await self.push_frame(LLMFullResponseStartFrame())
            await self.start_ttfb_metrics()
            try:

                async def on_delta(delta: str):
                    if not first.is_set():
                        first.set()
                        await self.stop_ttfb_metrics()
                    if self._interrupted:
                        return  # the voice stopped; the web still gets the whole reply
                    await self._speak(delta)

                state = await self._stream_turn(seq, text or "", on_delta, kind)
                if spoken:
                    self.turns += 1
                else:
                    self.continues += 1
                if state is None:
                    # Cut off: the web saved the turn as far as it got, so the next one is seq + 1.
                    self.state.seq = seq
                    logger.info(
                        "voice {} {} seq={} cut after {}ms",
                        kind,
                        self._sid,
                        seq,
                        int((time.monotonic() - started) * 1000),
                    )
                else:
                    self.state = state
                    logger.info(
                        "voice turn {} seq={} ms={} stage={} closed={}",
                        self._sid,
                        seq,
                        int((time.monotonic() - started) * 1000),
                        state.stage_index,
                        state.closed,
                    )
            except WebError as err:
                first.set()
                self.failures += 1
                logger.warning("voice turn {} seq={} refused: {}", self._sid, seq, err)
                if err.stale:
                    await self._on_stale(err)
                    return
                if err.code in ("turns", "time_up", "done", "session_budget"):
                    self.state.closed = {
                        "turns": "turns",
                        "time_up": "time",
                        "done": "done",
                        "session_budget": "budget",
                    }[err.code]
                elif not self._interrupted:
                    # A move that failed is asked for again by the silence after this line (the self-drive).
                    await self.push_frame(
                        TTSSpeakFrame(speech.MISSED if spoken else speech.MOMENT, append_to_context=False)
                    )
            except Exception as err:  # noqa: BLE001 - the web unreachable: say so, keep the line open
                first.set()
                self.failures += 1
                logger.error("voice {} {} seq={} failed: {}", kind, self._sid, seq, err)
                if not self._interrupted:
                    await self.push_frame(
                        TTSSpeakFrame(speech.MISSED if spoken else speech.MOMENT, append_to_context=False)
                    )
            finally:
                first.set()
                if filler:
                    filler.cancel()
                self._in_reply = False
                await self.push_frame(LLMFullResponseEndFrame())
            if self._interrupted:
                self._heard_sent = True
                await self._send_heard()
            await self._on_state(self.state)

    def _is_playing(self) -> bool:
        return self._playing is not None and self._playing()

    async def _send_heard(self) -> None:
        """Tells the web which words of the cut reply were heard."""
        spoken = self._spoken_text()
        if not spoken:
            return
        try:
            await self._web.played(self._sid, self.state.epoch, spoken)
        except Exception as err:  # noqa: BLE001
            logger.warning("voice played {}: {}", self._sid, err)

    async def _stream_turn(self, seq: int, text: str, on_delta, kind: str = "speech") -> State | None:
        """The web call for a turn, as a task so a cut-in can drop it: None when it was dropped. A turn
        the web refuses as busy (the previous reply's cut-off still being saved) is sent again shortly."""
        for attempt in range(3):
            self._stream = asyncio.ensure_future(
                self._web.turn(self._sid, self.state.epoch, seq, text, on_delta, kind=kind, on_draw=self._draw)
            )
            try:
                return await self._stream
            except asyncio.CancelledError:
                current = asyncio.current_task()
                if self._stream.cancelled() and not (current and current.cancelling()):
                    return None
                raise
            except WebError as err:
                if err.code != "busy" or attempt == 2:
                    raise
                await asyncio.sleep(0.15 * (attempt + 1))
            finally:
                self._stream = None
        raise AssertionError("unreachable")

    async def _speak(self, text: str) -> None:
        """The reply's words to the voice. A lesson's reply pauses after each sentence, and after a short setup
        ending in a colon: each is a segment of its own, with silence after it sized by conductor.pause_after."""
        if not self._pace:
            await self._say(text)
            return
        if self._ended and text[:1].isspace():
            await self._pause(self._ended)
            text = text.lstrip()
        for k, piece in enumerate(_BREAK.split(text)):
            if k:
                ms = pause_after(self._piece)
                if ms:
                    await self._pause(ms)
                else:
                    piece = " " + piece  # a long clause runs on past its colon
            await self._say(piece)
            self._piece += piece
        self._ended = pause_after(self._piece) if text and text[-1] in ".!?:" else 0

    async def _say(self, text: str) -> None:
        if not self._segment_said:
            # A segment's opening is held until it has a word: what follows a drawing may be only a space or the
            # "." of the drawing's sentence, and the speech service fails a context it is given nothing to say for.
            self._segment_lead += text
            if not _WORD.search(self._segment_lead):
                return
            text = _LEAD.sub("", self._segment_lead)
            self._segment_lead = ""
            self._segment_said = True
        await self.push_frame(LLMTextFrame(text))

    async def _pause(self, ms: int) -> None:
        self._piece = ""
        if not self._segment_said:
            return  # nothing said since the last pause or drawing
        await self.push_frame(SegmentEndFrame())
        await self.push_frame(PauseFrame(ms=ms))
        await self.push_frame(SegmentStartFrame())
        self._segment_said = False
        self._segment_lead = ""

    async def _draw(self, ops: list[Any], anchor: Any = None) -> None:
        """A drawing from the reply, where it stands in the words. Paced: the words before it are spoken as a
        segment, then each operation's label between its pen marks, then the reply goes on (bot/conductor.py).
        Not paced (an interview, a reply the learner cut into): drawn by the pen at its own pace. The board a lesson
        opens with (drawn in earlier lessons) is put on the board at once, without the pen."""
        if self._on_draw is None:
            return
        prelude = isinstance(anchor, dict) and bool(anchor.get("prelude"))
        if prelude:
            await self._on_draw(ops, None, True)  # on the board at once: it was drawn in earlier lessons
            return
        if not self._pace or self._interrupted or not self._in_reply:
            await self._on_draw(ops, None)
            return
        self._paced += 1
        ref = f"{self._pace_id}.{self._paced}"
        await self._on_draw(ops, ref)
        await self.push_frame(SegmentEndFrame())
        for item in pen_items(ops):
            await self.push_frame(PenMarkFrame(ref=ref, item=item, phase="before"))
            if item.speech:
                await self.push_frame(TTSSpeakFrame(item.speech, append_to_context=False, text_type=PEN_TEXT))
            await self.push_frame(PenMarkFrame(ref=ref, item=item, phase="after"))
        await self.push_frame(SegmentStartFrame())
        self._segment_said = False
        self._segment_lead = ""
        self._ended = 0
        self._piece = ""

    async def _filler(self, first: asyncio.Event) -> None:
        if self._filler_after <= 0:
            return  # fillers are off
        try:
            await asyncio.wait_for(first.wait(), timeout=self._filler_after)
        except TimeoutError:
            if not self._interrupted:
                self.fillers += 1
                await self.push_frame(TTSSpeakFrame(speech.filler(self._rng), append_to_context=False))
        except asyncio.CancelledError:
            pass


def _last_user_text(context) -> str:
    try:
        messages = context.get_messages()
    except Exception:  # noqa: BLE001
        messages = getattr(context, "messages", [])
    for m in reversed(list(messages or [])):
        role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
        if role != "user":
            continue
        content = m.get("content") if isinstance(m, dict) else getattr(m, "content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return " ".join(
                str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text"
            ).strip()
        return ""
    return ""
