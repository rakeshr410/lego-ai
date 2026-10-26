"""The voice says what the pen writes (bot/conductor.py): what is said for a label, when each word is said in
its audio, and the cues and pauses the conductor puts around it."""

from __future__ import annotations

import math
from array import array

from pipecat.frames.frames import (
    InterruptionFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from bot.conductor import Conductor, PauseFrame, PenMarkFrame, pen_items, speakable, voiced_runs, word_windows

RATE = 16000


def _audio(*parts: tuple[str, int]) -> bytes:
    """16-bit audio: ("tone", ms) is a voiced stretch, ("quiet", ms) silence."""
    out = array("h")
    for kind, ms in parts:
        n = RATE * ms // 1000
        if kind == "tone":
            out.extend(int(8000 * math.sin(2 * math.pi * 220 * k / RATE)) for k in range(n))
        else:
            out.extend([0] * n)
    return out.tobytes()


def test_what_is_said_for_what_is_written():
    assert speakable("border") == "border"
    assert speakable("article.card") == "article dot card"
    assert speakable("2×16") == "2 times 16"
    assert speakable("=") == "equals"
    assert speakable("320px") == "320 pixels"
    assert speakable("Last-Event-ID") == "Last Event ID"
    assert speakable("·") == "" and speakable("|") == "" and speakable("↑") == ""
    items = pen_items(
        [
            {"op": "region", "label": "border box"},
            {"op": "note", "text": "354 = 320 + 2×16"},
            {"op": "box", "label": "Top | Recent"},
            {"op": "arrow", "from": "a", "to": "b"},
            {"op": "highlight", "target": "a"},
        ]
    )
    assert [i.speech for i in items] == ["border box.", "354 equals 320 plus 2 times 16.", "Top, Recent.", "", ""]
    assert items[0].lead_ms > items[1].lead_ms  # a box's outline takes longer than moving to a note
    assert items[2].written == ["Top", "|", "Recent"] and items[2].spoken == ["Top", "", "Recent"]


def test_each_word_is_its_voiced_stretch_when_they_match():
    pcm = _audio(("quiet", 150), ("tone", 300), ("quiet", 100), ("tone", 200), ("quiet", 400))
    assert voiced_runs(pcm, RATE) == [(150, 450), (550, 750)]
    assert word_windows(["Border", "box"], ["Border", "box"], pcm, RATE) == [[150, 450], [550, 750]]
    # A mark that is not said is written in the instant after the word before it.
    assert word_windows(["Top", "|", "Recent"], ["Top", "", "Recent"], pcm, RATE) == [
        [150, 450],
        [450, 450],
        [550, 750],
    ]


def test_otherwise_the_speech_is_shared_by_how_long_each_word_takes():
    # One unbroken stretch for three words: shared in proportion to their syllables (1, 1, 2).
    pcm = _audio(("quiet", 100), ("tone", 800), ("quiet", 200))
    windows = word_windows(["the", "box", "model"], ["the", "box", "model"], pcm, RATE)
    assert windows == [[100, 300], [300, 500], [500, 900]]
    # No speech found at all: the whole audio.
    assert word_windows(["box"], ["box"], _audio(("quiet", 500)), RATE) == [[0, 500]]


def _cues(frames) -> list[dict]:
    return [f.message["data"] for f in frames if isinstance(f, OutputTransportMessageFrame)]


async def test_pauses_while_the_pen_draws_then_cues_each_word_right_before_the_label_plays():
    item = pen_items([{"op": "box", "label": "Border box"}])[0]
    label = _audio(("quiet", 150), ("tone", 300), ("quiet", 100), ("tone", 200), ("quiet", 250))
    before_text = TTSAudioRawFrame(audio=_audio(("tone", 100)), sample_rate=RATE, num_channels=1)
    after_text = TTSAudioRawFrame(audio=_audio(("tone", 100)), sample_rate=RATE, num_channels=1)
    conductor = Conductor()
    down, _ = await run_test(
        conductor,
        frames_to_send=[
            before_text,
            PenMarkFrame(ref="r.1", item=item, phase="before"),
            TTSStartedFrame(),
            TTSAudioRawFrame(audio=label[: len(label) // 2], sample_rate=RATE, num_channels=1),
            TTSTextFrame("Border", "word"),
            TTSAudioRawFrame(audio=label[len(label) // 2 :], sample_rate=RATE, num_channels=1),
            TTSTextFrame("box.", "word"),
            TTSStoppedFrame(),
            PenMarkFrame(ref="r.1", item=item, phase="after"),
            after_text,
        ],
        expected_down_frames=None,
    )
    kinds = [type(f).__name__ for f in down]
    assert kinds == [
        "TTSAudioRawFrame",  # the words before the drawing
        "OutputTransportMessageFrame",  # shape: the pen moves and draws the outline...
        "TTSAudioRawFrame",  # ...in this silence
        "OutputTransportMessageFrame",  # write: each word's window, sent right before the label's audio
        "TTSStartedFrame",
        "TTSAudioRawFrame",
        "TTSTextFrame",
        "TTSAudioRawFrame",
        "TTSTextFrame",
        "TTSStoppedFrame",
        "TTSAudioRawFrame",  # the pause after the label
        "TTSAudioRawFrame",  # the reply goes on
    ], kinds
    assert _cues(down) == [
        {"kind": "pen", "at": "shape", "ref": "r.1", "i": 0, "ms": item.lead_ms},
        {"kind": "pen", "at": "write", "ref": "r.1", "i": 0, "words": [[150, 450], [550, 750]]},
    ]
    silence = down[2].audio
    assert len(silence) == RATE * item.lead_ms // 1000 * 2 and not any(silence)
    assert len(down[10].audio) == RATE * item.tail_ms // 1000 * 2
    # The label's words are not the reply's (UsageObserver leaves them out of what was played).
    assert all(getattr(f, "pen_label", False) for f in down if isinstance(f, TTSTextFrame))
    assert conductor.labels == 1


async def test_a_mark_with_no_label_is_a_pause_and_a_cut_in_releases_the_pen():
    arrow = pen_items([{"op": "arrow", "from": "a", "to": "b"}])[0]
    box = pen_items([{"op": "box", "label": "Store"}])[0]
    conductor = Conductor()
    down = []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        down.append(frame)

    conductor.push_frame = push  # driven frame by frame: an interruption ends run_test's pipeline early
    for frame in (
        PenMarkFrame(ref="r.2", item=arrow, phase="before"),
        PenMarkFrame(ref="r.2", item=arrow, phase="after"),
        PenMarkFrame(ref="r.3", item=box, phase="before"),
        TTSAudioRawFrame(audio=_audio(("tone", 200)), sample_rate=RATE, num_channels=1),
        InterruptionFrame(),
    ):
        await conductor.process_frame(frame, FrameDirection.DOWNSTREAM)
    assert _cues(down) == [
        {"kind": "pen", "at": "shape", "ref": "r.2", "i": 0, "ms": arrow.lead_ms},
        {"kind": "pen", "at": "shape", "ref": "r.3", "i": 0, "ms": box.lead_ms},
    ]
    # The held label audio is dropped with the rest of the reply, and the room draws what is left at once.
    urgent = [f.message["data"] for f in down if isinstance(f, OutputTransportMessageUrgentFrame)]
    assert urgent == [{"kind": "pen", "at": "release"}]
    audio = [f for f in down if isinstance(f, TTSAudioRawFrame)]
    assert len(audio) == 3  # the arrow's pause and tail, the box's pause; not the label


def test_labels_read_as_words_not_code():
    items = pen_items(
        [
            {"op": "box", "label": "Viewport, 780 px"},
            {"op": "box", "label": "ul#list"},
            {"op": "note", "text": "in a p: a word on a line"},
            {"op": "note", "text": "none positioned → initial containing block"},
            {"op": "box", "label": "li[data-id=i-0417]"},
        ]
    )
    assert [i.speech for i in items] == [
        "Viewport, 780 pixels.",
        "ul list.",
        "in a paragraph, a word on a line.",
        "none positioned leads to initial containing block.",
        "li data id i 0417.",
    ]
    assert speakable("10→20") == "10 leads to 20"


def test_json_lines_and_endpoints_read_as_words_with_their_pauses():
    items = pen_items(
        [
            {"op": "note", "text": "tweets: { s1: { text, time, authorId } },"},
            {"op": "note", "text": "}"},
            {"op": "note", "text": "GET /api/tweets?limit=10&cursor=c1"},
            {"op": "note", "text": "GET /api/tweets/stream"},
        ]
    )
    assert [i.speech for i in items] == [
        "tweets, s1, text, time, authorId.",
        "",
        "GET api tweets with limit 10 and cursor c1.",
        "GET api tweets stream.",
    ]


def test_a_word_said_with_a_break_in_it_keeps_its_runs_together():
    # "Places search": "Pla" "ces" with a break, then "search": three runs for two words.
    pcm = _audio(
        ("quiet", 100), ("tone", 250), ("quiet", 80), ("tone", 200), ("quiet", 120), ("tone", 350), ("quiet", 100)
    )
    assert len(voiced_runs(pcm, RATE)) == 3
    assert word_windows(["Places", "search"], ["Places", "search"], pcm, RATE) == [[100, 630], [750, 1100]]


def test_no_word_is_written_in_a_flash():
    # Two runs for three words, the last two said together in a short run: each still gets time to be written.
    pcm = _audio(("quiet", 100), ("tone", 700), ("quiet", 100), ("tone", 120), ("quiet", 100))
    windows = word_windows(["next", "frame", "layout"], ["next", "frame", "layout"], pcm, RATE)
    assert windows[0][0] == 100 and windows[-1][1] == 1020
    assert [b - a >= 30 * len(w) for (a, b), w in zip(windows, ["next", "frame", "layout"])] == [True] * 3
    assert all(windows[k][1] <= windows[k + 1][0] for k in range(2))


async def test_a_pause_between_sentences_is_that_much_silence():
    conductor = Conductor()
    down = []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        down.append(frame)

    conductor.push_frame = push
    await conductor.process_frame(PauseFrame(ms=450), FrameDirection.DOWNSTREAM)
    (silence,) = down
    assert isinstance(silence, TTSAudioRawFrame) and set(silence.audio) == {0}
    assert len(silence.audio) == 2 * silence.sample_rate * 450 // 1000
