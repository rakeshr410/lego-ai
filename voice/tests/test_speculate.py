"""The speculative start: the words heard go to the web at the VAD's stop (and again when a late final changes them), when no
reply is in flight."""

import asyncio

import pytest
from pipecat.frames.frames import (
    EagerTranscriptionFrame,
    InterimTranscriptionFrame,
    LLMContextFrame,
    TranscriptionFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from bot.speculate import Speculator


class FakeWeb:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str]] = []

    async def speculate(self, sid: str, epoch: int, text: str) -> bool:
        self.calls.append((sid, epoch, text))
        return True


def push(frame, source=None) -> FramePushed:
    return FramePushed(source=source, destination=None, frame=frame, direction=FrameDirection.DOWNSTREAM, timestamp=0)


async def settle() -> None:
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_the_words_heard_go_out_once_at_the_stop_and_the_turn_resets_them() -> None:
    web = FakeWeb()
    busy = {"on": False}
    obs = Speculator(web=web, sid="s", epoch=lambda: 3, busy=lambda: busy["on"])  # type: ignore[arg-type]
    await obs.on_push_frame(push(TranscriptionFrame("so the users", "u", "t")))
    await obs.on_push_frame(push(InterimTranscriptionFrame("are agents", "u", "t")))
    stop = VADUserStoppedSpeakingFrame()
    await obs.on_push_frame(push(stop))
    await obs.on_push_frame(push(stop))  # the next processor pushes the same frame on
    await settle()
    assert web.calls == [("s", 3, "so the users are agents")]
    # The turn controller's own stop frame follows the inference and is not the trigger.
    await obs.on_push_frame(push(UserStoppedSpeakingFrame()))
    await settle()
    assert len(web.calls) == 1
    # A late final that only confirms the interim is not a new guess.
    await obs.on_push_frame(push(TranscriptionFrame("are agents", "u", "t")))
    await settle()
    assert len(web.calls) == 1
    # A late final that changes the words is: the web replaces the first guess.
    await obs.on_push_frame(push(TranscriptionFrame("mostly bots", "u", "t")))
    await settle()
    assert web.calls[-1] == ("s", 3, "so the users are agents mostly bots")
    assert obs.started == 2
    # The candidate resumed: finals during speech wait for the next stop.
    await obs.on_push_frame(push(VADUserStartedSpeakingFrame()))
    await obs.on_push_frame(push(TranscriptionFrame("and some humans", "u", "t")))
    await settle()
    assert len(web.calls) == 2
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame()))
    await settle()
    assert web.calls[-1][2] == "so the users are agents mostly bots and some humans"
    # The turn went to the interviewer: nothing is left of it.
    await obs.on_push_frame(push(LLMContextFrame(context=None)))  # type: ignore[arg-type]
    assert obs.heard() == ""
    # While a reply is in flight, a cut-in makes no guess.
    busy["on"] = True
    await obs.on_push_frame(push(TranscriptionFrame("wait", "u", "t")))
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame()))
    await settle()
    assert len(web.calls) == 3


@pytest.mark.asyncio
async def test_only_the_shaper_s_transcripts_count() -> None:
    web = FakeWeb()
    shaper = FrameProcessor(name="shaper")
    stt = FrameProcessor(name="stt")
    obs = Speculator(web=web, sid="s", epoch=lambda: 1, busy=lambda: False, transcripts=shaper)  # type: ignore[arg-type]
    await obs.on_push_frame(push(TranscriptionFrame("um so the users", "u", "t"), source=stt))
    await obs.on_push_frame(push(TranscriptionFrame("so the users", "u", "t"), source=shaper))
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame()))
    await settle()
    assert web.calls == [("s", 1, "so the users")]


@pytest.mark.asyncio
async def test_a_transcriber_s_own_prediction_is_the_guess() -> None:
    web = FakeWeb()
    obs = Speculator(web=web, sid="s", epoch=lambda: 1, busy=lambda: False, eager=True)  # type: ignore[arg-type]
    # Interims and the VAD's stop make no guess: the prediction will carry the whole turn.
    await obs.on_push_frame(push(InterimTranscriptionFrame("so the", "u", "t")))
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame()))
    await settle()
    assert web.calls == []
    await obs.on_push_frame(push(EagerTranscriptionFrame("Um, so the users are agents.", "u", "t")))
    await settle()
    assert web.calls == [("s", 1, "so the users are agents.")]
    # The committed final after it is not posted again (the web matches the words); the turn resets.
    await obs.on_push_frame(push(TranscriptionFrame("So the users are agents.", "u", "t")))
    await settle()
    assert len(web.calls) == 1
    await obs.on_push_frame(push(LLMContextFrame(context=None)))  # type: ignore[arg-type]
    assert obs.heard() == ""
    # Pipecat's own speculative context frame does not end the turn.
    await obs.on_push_frame(push(EagerTranscriptionFrame("then caching", "u", "t")))
    await obs.on_push_frame(push(LLMContextFrame(context=None, speculation=True)))  # type: ignore[arg-type]
    assert obs.heard() == "then caching"
