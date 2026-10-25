"""The latency line: one exchange's legs measured from the candidate's last word."""

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    InterimTranscriptionFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import TurnMetricsData
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection

from bot.latency import LatencyObserver


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def push(frame) -> FramePushed:
    return FramePushed(source=None, destination=None, frame=frame, direction=FrameDirection.DOWNSTREAM, timestamp=0)


@pytest.mark.asyncio
async def test_one_exchange_is_measured_from_the_last_word() -> None:
    clock = Clock()
    obs = LatencyObserver("sid", clock=clock)
    # A pause mid-answer: VAD stops, the candidate goes on; only the last stop counts.
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame(stop_secs=0.2, timestamp=99.0)))
    await obs.on_push_frame(push(VADUserStartedSpeakingFrame()))
    await obs.on_push_frame(push(InterimTranscriptionFrame("so the", "u", "t")))
    clock.t = 100.2
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame(stop_secs=0.2, timestamp=100.2)))
    await obs.on_push_frame(
        push(
            MetricsFrame(
                data=[TurnMetricsData(processor="st", is_complete=True, probability=0.91, e2e_processing_time_ms=40)]
            )
        )
    )
    clock.t = 100.35
    await obs.on_push_frame(push(TranscriptionFrame("so the users are agents", "u", "t")))
    clock.t = 100.4
    await obs.on_push_frame(push(UserStoppedSpeakingFrame()))
    clock.t = 101.3
    await obs.on_push_frame(push(LLMTextFrame("Right,")))
    clock.t = 101.6
    await obs.on_push_frame(push(TTSAudioRawFrame(audio=b"\0\0", sample_rate=24000, num_channels=1)))
    clock.t = 101.7
    await obs.on_push_frame(push(BotStartedSpeakingFrame()))
    assert obs.exchanges == [
        {
            "eot_ms": 400,
            "transcript_ms": 350,
            "ttft_ms": 900,
            "first_audio_ms": 1200,
            "total_ms": 1700,
            "filler": "no",
            "smart_turn": "complete p=0.91 40ms",
            "smart_turn_runs": 1,
            "turns": 1,
        }
    ]


@pytest.mark.asyncio
async def test_a_filler_before_the_first_token_is_marked() -> None:
    clock = Clock()
    obs = LatencyObserver("sid", clock=clock)
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame(stop_secs=0.2, timestamp=100.0)))
    clock.t = 100.3
    await obs.on_push_frame(push(UserStoppedSpeakingFrame()))
    clock.t = 101.5
    await obs.on_push_frame(push(TTSAudioRawFrame(audio=b"\0\0", sample_rate=24000, num_channels=1)))
    clock.t = 101.6
    await obs.on_push_frame(push(BotStartedSpeakingFrame()))
    assert obs.exchanges[0]["filler"] == "no"  # no token yet: unknown, not claimed
    # The interviewer's own speech (the opener) before any candidate turn is not an exchange.
    assert len(obs.exchanges) == 1


@pytest.mark.asyncio
async def test_a_stop_pushed_through_several_processors_counts_one_turn() -> None:
    clock = Clock()
    obs = LatencyObserver("sid", clock=clock)
    await obs.on_push_frame(push(VADUserStoppedSpeakingFrame(stop_secs=0.2, timestamp=100.0)))
    stop = UserStoppedSpeakingFrame()
    for _ in range(4):
        await obs.on_push_frame(push(stop))
    await obs.on_push_frame(push(LLMTextFrame("Hi")))
    await obs.on_push_frame(push(TTSAudioRawFrame(audio=b"\0\0", sample_rate=24000, num_channels=1)))
    await obs.on_push_frame(push(BotStartedSpeakingFrame()))
    assert obs.exchanges[-1]["turns"] == 1
