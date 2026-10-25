from __future__ import annotations

from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.tests.utils import run_test

from bot.turn_shaper import TurnShaper, shape


def test_shape_cleans_hesitation_and_space():
    assert shape("  um, so  the feed   loads first ") == "so the feed loads first"
    assert shape("Um.") == ""
    assert shape("uh uh hmm") == ""
    assert shape("we cache it, um") == "we cache it,"
    assert shape("Yes.") == "Yes."
    assert shape("umbrella pattern") == "umbrella pattern"


async def test_drops_fragments_without_words_and_keeps_interims():
    shaper = TurnShaper()
    frames = [
        TranscriptionFrame(text="  um ", user_id="c", timestamp="t"),
        InterimTranscriptionFrame(text="mobile we", user_id="c", timestamp="t"),
        TranscriptionFrame(text="uh, mobile web first", user_id="c", timestamp="t"),
    ]
    down, _ = await run_test(
        shaper, frames_to_send=frames, expected_down_frames=[InterimTranscriptionFrame, TranscriptionFrame]
    )
    assert [f.text for f in down] == ["mobile we", "mobile web first"]
    assert shaper.dropped == 1
