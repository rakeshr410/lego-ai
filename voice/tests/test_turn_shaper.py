from __future__ import annotations

from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.tests.utils import run_test

from bot.echo import VoiceMemory, is_echo
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


def test_an_echo_is_the_voices_words_in_its_order():
    said = "Right, the margin sits outside the border. What is the total width of the card?"
    assert is_echo("the margin sits outside the border", said, speaking=False)
    assert is_echo("What is the total width of the card", said, speaking=False)
    # The learner's own sentence, even with the voice's words in it, is not an echo.
    assert not is_echo("the card is three hundred fifty four wide", said, speaking=False)
    assert not is_echo("the margin is outside the border", said, speaking=False)
    # A short reply is the learner's unless the voice is speaking and just said it.
    assert not is_echo("the card", said, speaking=False)
    assert is_echo("the card", said, speaking=True)
    assert not is_echo("yes", said, speaking=True)


def test_voice_memory_forgets_old_words_and_knows_when_the_voice_just_stopped():
    now = [0.0]
    memory = VoiceMemory(clock=lambda: now[0])
    memory.started()
    memory.played("Border box.")
    assert memory.echoes("border box")
    memory.stopped()
    now[0] = 1.0
    assert memory.echoes("border box")
    now[0] = 3.0
    assert not memory.echoes("border box")  # short, and the voice stopped a while ago
    memory.played("padding sits inside the border")
    now[0] = 20.0
    assert not memory.echoes("padding sits inside the border")  # forgotten


async def test_drops_the_voices_own_words_heard_back():
    memory = VoiceMemory()
    memory.played("Content box, then padding, then border.")
    shaper = TurnShaper(echoes=memory.echoes)
    frames = [
        TranscriptionFrame(text="content box then padding", user_id="c", timestamp="t"),
        TranscriptionFrame(text="so the border is outside", user_id="c", timestamp="t"),
    ]
    down, _ = await run_test(shaper, frames_to_send=frames, expected_down_frames=[TranscriptionFrame])
    assert [f.text for f in down] == ["so the border is outside"]
    assert shaper.echoes == 1
