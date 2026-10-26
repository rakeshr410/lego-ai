from __future__ import annotations

import asyncio

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    ErrorFrame,
    InputAudioRawFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.tests.utils import run_test
from pipecat.utils.text.base_text_aggregator import TextType

from bot.idle import IdleGate, IdleTimer
from bot.observers import UsageObserver
from bot.sync import Heartbeat


async def test_idle_rungs_fire_in_order_after_the_bot_stops_and_reset_when_someone_speaks():
    fired = []

    async def on_rung(r):
        fired.append(r)

    # The timer counts in seconds; the test scales them.
    timer = IdleTimer([1, 2], on_rung, sleep=lambda s: asyncio.sleep(s / 50))
    timer.arm()
    await asyncio.sleep(0.12)
    assert fired == [1, 2] and not timer.armed
    fired.clear()
    timer.arm()
    await asyncio.sleep(0.01)
    timer.disarm()
    await asyncio.sleep(0.12)
    assert fired == []
    timer.hold(10)
    timer.arm()
    await asyncio.sleep(0.12)
    assert fired == []
    timer.disarm()


async def test_idle_gate_arms_when_the_bot_stops_and_disarms_when_someone_speaks():
    async def on_rung(r):
        pass

    timer = IdleTimer([60], on_rung)
    gate = IdleGate(timer=timer)
    frames = [BotStoppedSpeakingFrame(), UserStartedSpeakingFrame()]
    seen = []
    orig_arm, orig_disarm = timer.arm, timer.disarm
    timer.arm = lambda: (seen.append("arm"), orig_arm())  # type: ignore[method-assign]
    timer.disarm = lambda: (seen.append("disarm"), orig_disarm())  # type: ignore[method-assign]
    await run_test(
        gate, frames_to_send=frames, expected_down_frames=[BotStoppedSpeakingFrame, UserStartedSpeakingFrame]
    )
    assert seen[:3] == ["arm", "disarm", "disarm"]  # the second disarm is the end frame's
    assert not timer.armed


async def test_a_cut_in_holds_the_lessons_next_move_until_the_learner_has_finished_and_a_while_after():
    moves = []

    async def on_rung(r):
        pass

    async def on_continue():
        moves.append(1)

    timer = IdleTimer([60], on_rung, on_continue=on_continue)
    timer.self_drive = 1.5
    gate = IdleGate(timer=timer)
    armed = []
    orig_arm = timer.arm
    timer.arm = lambda extra=0.0: (armed.append(extra), orig_arm(extra))  # type: ignore[method-assign]
    # The learner cuts in: they start, the voice stops for them (no move then), they finish.
    frames = [UserStartedSpeakingFrame(), BotStoppedSpeakingFrame(), UserStoppedSpeakingFrame()]
    await run_test(gate, frames_to_send=frames, expected_down_frames=None)
    assert armed == [3.0] and moves == []


class _P(FrameProcessor):
    pass


async def test_usage_counts_audio_seconds_and_spoken_characters():
    audio_in, audio_out, stt, tts = _P(name="in"), _P(name="out"), _P(name="stt"), _P(name="tts")
    usage = UsageObserver(audio_in=audio_in, audio_out=audio_out, stt=stt, tts=tts)

    async def push(frame, source):
        await usage.on_push_frame(
            FramePushed(source=source, destination=None, frame=frame, direction=FrameDirection.DOWNSTREAM, timestamp=0)
        )

    await push(InputAudioRawFrame(audio=b"\0" * 32000, sample_rate=16000, num_channels=1), audio_in)
    await push(InputAudioRawFrame(audio=b"\0" * 16000, sample_rate=16000, num_channels=1), audio_in)
    assert usage.stt_seconds == 1.5
    await push(TTSTextFrame(text="Who are the users,", text_type=TextType.SENTENCE), tts)
    await push(TTSTextFrame(text=" and on which devices?", text_type=TextType.SENTENCE), tts)
    assert usage.tts_chars == len("Who are the users, and on which devices?")
    await push(BotStartedSpeakingFrame(), audio_out)
    await push(TTSTextFrame(text="Who are the users,", text_type=TextType.SENTENCE), audio_out)
    assert usage.spoken_text() == "Who are the users,"
    await push(ErrorFrame(error="ws closed"), tts)
    assert usage.degraded == {"tts"}
    await push(ErrorFrame(error="other"), audio_in)
    assert usage.degraded == {"tts"}


async def test_heartbeat_reports_usage_and_stops_on_close_or_stale(web, fake_web):
    usage = UsageObserver(audio_in=None, audio_out=None, stt=None, tts=None)
    usage.stt_seconds, usage.tts_chars = 30, 400
    closed, stale = [], []

    async def on_closed(r):
        closed.append(r)

    async def on_stale(e):
        stale.append(e.code)

    hb = Heartbeat(
        web=web, sid="a" * 24, epoch=1, usage=usage, period_secs=0.01, on_closed=on_closed, on_stale=on_stale
    )
    hb.start()
    await asyncio.sleep(0.05)
    assert hb.beats >= 2 and closed == []
    assert fake_web.calls[-1][2]["sttSeconds"] == 30
    fake_web.closed = "time"
    await asyncio.sleep(0.05)
    assert closed == ["time"]
    hb.stop()

    fake_web.closed = None
    fake_web.epoch = 2
    hb2 = Heartbeat(
        web=web, sid="a" * 24, epoch=1, usage=usage, period_secs=0.01, on_closed=on_closed, on_stale=on_stale
    )
    hb2.start()
    await asyncio.sleep(0.05)
    assert stale == ["stale_epoch"]
    hb2.stop()


async def test_a_lessons_self_drive_asks_for_the_next_move_instead_of_running_the_rungs():
    fired, moves = [], []

    async def on_rung(r):
        fired.append(r)

    async def on_continue():
        moves.append(1)

    timer = IdleTimer([1, 2], on_rung, sleep=lambda s: asyncio.sleep(s / 50), on_continue=on_continue)
    timer.self_drive = 0.5
    timer.arm()
    await asyncio.sleep(0.12)
    # The move comes at its mark and the clock stops there: the move's own speech arms it again.
    assert moves == [1] and fired == [] and timer.continued == 1 and not timer.armed
    # A long self-drive (the learner is asked a question) lets the rungs run first.
    timer.self_drive = 3
    timer.arm()
    await asyncio.sleep(0.25)
    assert fired == [1, 2] and moves == [1, 1]
    # Without one (an interview), the rungs alone.
    timer.self_drive = None
    fired.clear()
    timer.arm()
    await asyncio.sleep(0.12)
    assert fired == [1, 2] and moves == [1, 1]
