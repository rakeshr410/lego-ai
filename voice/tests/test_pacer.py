"""The drawing keeps time with the voice (bot/pacer.py; docs/interview/coach-mode.md, phase 5)."""

from __future__ import annotations

import asyncio

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    TextType,
    TTSTextFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from bot.observers import UsageObserver
from bot.pacer import DrawPacer

A = [{"op": "box", "label": "A"}]
B = [{"op": "box", "label": "B"}, {"op": "arrow", "from": "A", "to": "B"}]
C = [{"op": "note", "text": "C"}]


class Clock:
    t = 0.0

    def __call__(self) -> float:
        return self.t


def _pacer(spoken: dict[str, int], sent: list, **kw) -> DrawPacer:
    async def send(ops):
        sent.append(ops)

    return DrawPacer(spoken_words=lambda: spoken["n"], send=send, **kw)


async def test_holds_each_drawing_until_its_words_have_played_and_lands_them_in_order():
    spoken, sent = {"n": 0}, []
    clock = Clock()
    p = _pacer(spoken, sent, clock=clock)
    await p.draw(A, {"words": 6})
    await p.draw(B, {"words": 12})
    assert sent == [] and p.pending == 2
    spoken["n"] = 4
    await p.spoken()
    assert sent == []
    # A word of slack: the voice's count and the web's differ on a hyphen or an abbreviation.
    spoken["n"] = 5
    await p.spoken()
    assert sent == [A] and p.pending == 1
    spoken["n"] = 11
    await p.spoken()
    assert sent == [A, B] and p.pending == 0 and p.held == 2 and p.sent == 2
    # No anchor, or its words already out: at once.
    await p.draw(C, None)
    assert sent[-1] == C
    spoken["n"] = 20
    await p.draw(A, {"words": 15})
    assert sent[-1] == A and p.pending == 0


async def test_the_reply_stopping_lands_what_is_held_and_a_long_hold_lands_by_itself():
    spoken, sent = {"n": 0}, []
    clock = Clock()
    p = _pacer(spoken, sent, clock=clock)
    await p.draw(A, {"words": 30})
    await p.draw(B, {"words": 40})
    await p.flush()  # the learner cut in, or the voice reached the end
    assert sent == [A, B] and p.pending == 0
    # Held past the limit (a voice that reports no words): the next nudge lands it.
    await p.draw(C, {"words": 30})
    clock.t = 21.0
    await p.spoken()
    assert sent[-1] == C
    # ...and with nothing nudging it, the watch does, on the real clock.
    quick = _pacer(spoken, sent, max_hold_secs=0.02)
    await quick.draw(A, {"words": 99})
    assert quick.pending == 1
    await asyncio.sleep(0.15)
    assert quick.pending == 0 and sent[-1] == A


async def test_the_observer_counts_the_words_played_and_tells_the_pacer():
    out, tts = FrameProcessor(), FrameProcessor()
    usage = UsageObserver(audio_in=None, audio_out=out, stt=None, tts=tts)
    events: list[tuple[str, int]] = []

    async def on_spoken():
        events.append(("spoken", usage.spoken_words()))

    async def on_stopped():
        events.append(("stopped", usage.spoken_words()))

    usage.on_spoken = on_spoken
    usage.on_stopped = on_stopped

    async def push(frame, source):
        await usage.on_push_frame(
            FramePushed(source=source, destination=out, frame=frame, direction=FrameDirection.DOWNSTREAM, timestamp=0)
        )

    await push(LLMFullResponseStartFrame(), tts)
    # Synthesised, not yet played: counts characters only.
    await push(TTSTextFrame(text="Here is the gateway.", text_type=TextType.SENTENCE), tts)
    assert usage.tts_chars == 20 and usage.spoken_words() == 0 and events == []
    for word in ["Here", "is", "the", "gateway."]:
        await push(TTSTextFrame(text=word, text_type=TextType.WORD), out)
    await push(BotStoppedSpeakingFrame(), out)
    assert events == [("spoken", 1), ("spoken", 2), ("spoken", 3), ("spoken", 4), ("stopped", 4)]
    assert usage.spoken_text() == "Here is the gateway."
    # A cut-in stops the reply too.
    await push(InterruptionFrame(), out)
    assert events[-1] == ("stopped", 4) and usage.interrupted
    # The next reply starts the count over.
    await push(LLMFullResponseStartFrame(), tts)
    assert usage.spoken_words() == 0
