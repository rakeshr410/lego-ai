"""The speculative start (README "Latency"): the reply begins before the turn is confirmed.

The VAD hears the candidate stop 0.2 s after their last word; the turn is confirmed only once the
transcriber's final words are in and smart-turn has ruled, 0.3 to 0.7 s later. This observer posts the
words heard so far (the shaped finals and the newest interim) to the web at the VAD's stop, and the web
starts the model on them (prefetch.ts). A final that lands after the stop and changes the words is posted
again (the web drops the first guess). When the confirmed turn carries the same words, its reply is that
much ahead; when it does not, the guess costs one unused call. No guess is made while a reply is in
flight (a cut-in queues behind it, on a transcript the guess would not have), and the same words are not
posted twice.

The trigger is the VAD's `VADUserStoppedSpeakingFrame`, not `UserStoppedSpeakingFrame`: the turn
controller fires the inference (the `LLMContextFrame` that ends the guess) before it announces the stop.

With a transcriber that predicts the end of a turn itself (Deepgram Flux, `EagerTranscriptionFrame`:
the whole turn as heard, pushed when the prediction is made), the prediction is the guess and the
VAD's stop is not used: Flux's prediction carries the words the committed turn will carry, where an
interim at the stop lags the final by a word or two.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from loguru import logger
from pipecat.frames.frames import (
    EagerTranscriptionFrame,
    InterimTranscriptionFrame,
    LLMContextFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameProcessor

from app.web_client import WebClient
from bot.turn_shaper import shape


class Speculator(BaseObserver):
    def __init__(
        self,
        *,
        web: WebClient,
        sid: str,
        epoch: Callable[[], int],
        busy: Callable[[], bool],
        transcripts: FrameProcessor | None = None,
        eager: bool = False,
        **kwargs,
    ):
        """`transcripts` is the processor whose transcription frames count (the turn shaper's, shaped and
        pushed once); None takes every push, for tests. `eager`: the transcriber predicts the end of turn
        (EagerTranscriptionFrame) and only that prediction is posted."""
        super().__init__(**kwargs)
        self._web = web
        self._sid = sid
        self._epoch = epoch
        self._busy = busy
        self._source = transcripts
        self._eager = eager
        self._predicted = ""
        self._finals: list[str] = []
        self._interim = ""
        self._last_stop: int | None = None
        self._stopped = False  # the VAD has heard the stop; the turn is not yet confirmed
        self._last_sent = ""
        self._tasks: set[asyncio.Task[None]] = set()
        self.sent = 0
        self.started = 0

    def heard(self) -> str:
        """The words of the turn so far: the transcriber's prediction of the whole turn when it made one."""
        if self._predicted:
            return self._predicted
        return " ".join([*self._finals, *([self._interim] if self._interim else [])]).strip()

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame
        if isinstance(frame, EagerTranscriptionFrame):
            if self._source is not None and data.source is not self._source:
                return
            self._predicted = shape(frame.text)
            self._guess()
        elif isinstance(frame, InterimTranscriptionFrame | TranscriptionFrame):
            if self._source is not None and data.source is not self._source:
                return
            if isinstance(frame, InterimTranscriptionFrame):
                self._interim = frame.text.strip()
            elif frame.text.strip():
                self._finals.append(frame.text.strip())
                self._interim = ""
                if self._stopped and not self._eager:
                    self._guess()  # the final words, in after the stop and before the verdict
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            if frame.id == self._last_stop:
                return  # the same frame, pushed on by the next processor
            self._last_stop = frame.id
            self._stopped = True
            if not self._eager:
                self._guess()
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            self._stopped = False
        elif isinstance(frame, LLMContextFrame):
            if frame.speculation:
                return  # Pipecat's own speculation, not used here (run.py); the turn is still open
            # The turn went to the interviewer: the next one starts from nothing.
            self._finals.clear()
            self._interim = ""
            self._predicted = ""
            self._last_sent = ""
            self._stopped = False

    def _guess(self) -> None:
        text = self.heard()
        if not text or text == self._last_sent or self._busy():
            return
        self._last_sent = text
        logger.debug("voice speculate {}: {} words posted", self._sid, len(text.split()))
        task = asyncio.create_task(self._send(text))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, text: str) -> None:
        self.sent += 1
        try:
            if await self._web.speculate(self._sid, self._epoch(), text):
                self.started += 1
        except Exception as err:  # noqa: BLE001 - a guess that fails costs nothing but the guess
            logger.debug("voice speculate {}: {}", self._sid, err)
