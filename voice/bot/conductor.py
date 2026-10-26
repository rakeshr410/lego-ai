"""The voice says what the pen writes, as it writes it (docs/coach-mode.md, phase 6).

A coach's drawing arrives inside its reply's words. The voice and the pen take turns around it:

1. The gateway splits the reply's speech at the drawing (`SegmentEndFrame`, which makes the voice speak the
   words so far as their own segment) and, for each operation, sends a `PenMarkFrame` ("before"), the
   operation's label as a segment of its own (a `TTSSpeakFrame` of `PEN_TEXT`), and a second mark ("after").
   The marks are ordinary frames, so the voice service queues them between the segments' audio, in order.
2. Here, after the voice: at "before", the room is told the pen may move and draw the outline (`shape`, with
   the time it has), and that much silence goes out, so the pen moves while the voice pauses. The label's audio
   is then held back until "after" arrives, which is when all of it has been made. Its speech is measured
   (where each word starts and ends: `word_windows`), the room is told (`write`, with a window per written
   word), and the audio goes out right behind the message, then a short silence after the label.
3. In the room, the pen starts the outline when `shape` plays and writes each word's characters inside that
   word's window from when `write` plays (lib/board/pen), so the voice says "border box" while the pen writes
   it, and pauses before and after while the pen travels.

The messages travel in the audio's queue (OutputTransportMessageFrame), so each is sent when the audio before it
has been sent, which is what makes the timing hold whatever the voice's speed or delay. The drawing itself goes
to the room as soon as the web sends it (with a `pace` reference), so the pen has it queued; when the learner
cuts in, the queued audio and marks are dropped and the room is told to `release`: the pen finishes the mark the
voice had reached and leaves the rest undrawn, as the voice never said them.
"""

from __future__ import annotations

import re
import time
from array import array
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pipecat.processors.frameworks.rtvi.models as RTVI
from loguru import logger
from pipecat.frames.frames import (
    DataFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
    SystemFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# The text type of a label the voice reads as the pen writes it (not part of the reply's words).
PEN_TEXT = "pen"

# How long the pen has before a label is spoken (move to the mark and draw its outline), and the pause after it.
LEAD_MS = {
    "box": 900,
    "region": 900,
    "rename": 1300,
    "arrow": 800,
    "note": 450,
    "highlight": 700,
    "erase": 700,
    "clear": 400,
}
TAIL_MS = 280
QUIET_TAIL_MS = 120
# The pauses in a lesson's reply (the gateway speaks each sentence as a segment of its own), on top of the voice's
# own, so the learner has time to take each statement in: after a sentence, longer after a question (time to think),
# and a short beat after a setup that ends in a colon ("Picture this:", "Here's the catch:").
SENTENCE_PAUSE_MS = 800
QUESTION_PAUSE_MS = 1200
SETUP_PAUSE_MS = 450
# A colon ends a setup when this many words or fewer lead to it; a longer clause runs on into what it introduces.
SETUP_MAX_WORDS = 4


def pause_after(piece: str) -> int:
    """The silence after a piece of a lesson's reply that ends at a break: 0 when it is not one (a long clause
    before a colon)."""
    s = piece.rstrip()
    if s.endswith("?"):
        return QUESTION_PAUSE_MS
    if s.endswith(":"):
        return SETUP_PAUSE_MS if len(s.split()) <= SETUP_MAX_WORDS else 0
    return SENTENCE_PAUSE_MS
# A label's audio is held at most this long (a voice that never finishes it): it goes out as it is.
MAX_HOLD_SECS = 4.0

# Speech detection over the label's audio: 10 ms frames, voiced above a share of the loudest frame, and a gap of
# at least GAP_MS between voiced runs is a pause between words.
FRAME_MS = 10
VOICED_SHARE = 0.08
VOICED_FLOOR = 180.0
GAP_MS = 60
# The least time the pen takes over a word, by its characters, up to a cap: a word given 10 ms by the speech
# found in it would be written in a flash. The time comes from its neighbours; the label's span is kept.
CHAR_MIN_MS = 30
WORD_MIN_MS = 320


class SegmentEndFrame(LLMFullResponseEndFrame):
    """The words of a reply up to a drawing: the voice speaks them as a segment of their own."""


class SegmentStartFrame(LLMFullResponseStartFrame):
    """The reply's words after a drawing (the same reply: what was played so far is kept)."""


@dataclass
class PenItem:
    """One operation of a drawing, as the voice and the pen share it."""

    index: int
    lead_ms: int
    # The label's words as the pen writes them, and each as the voice says it ("" for a mark not said: "·").
    written: list[str] = field(default_factory=list)
    spoken: list[str] = field(default_factory=list)

    @property
    def speech(self) -> str:
        """What the voice says: the spoken words, a separator read as a comma, ending as a label does."""
        out: list[str] = []
        for w, s in zip(self.written, self.spoken, strict=True):
            if s:
                # A key or an item that ends in a comma or a colon is said with a pause after it.
                out.append(f"{s}," if w.rstrip("\"'}])").endswith((",", ":")) and not s.endswith(",") else s)
            elif out and _SEPARATOR.fullmatch(w) and not out[-1].endswith(","):
                out[-1] += ","
        text = " ".join(out).rstrip(",")
        return f"{text}." if text and text[-1] not in ".?!" else text

    @property
    def tail_ms(self) -> int:
        return TAIL_MS if self.speech else QUIET_TAIL_MS


@dataclass
class PauseFrame(DataFrame):
    """Silence between two segments of a reply (a lesson's pause after a sentence)."""

    ms: int


@dataclass
class PenMarkFrame(DataFrame):
    """Where an operation's label sits among the voice's segments: `before` it, or `after` it."""

    ref: str
    item: PenItem
    phase: str


# ---------------------------------------------------------------------------------------------------------
# What is said for what is written


_SEPARATOR = re.compile(r"[|·•/\\,;:–—-]+")
_SYMBOLS = {
    "×": "times",
    "x": "times",
    "=": "equals",
    "+": "plus",
    "→": "leads to",
    "->": "leads to",
    "=>": "leads to",
    "←": "from",
    "<-": "from",
    "%": "percent",
    "&": "and",
    "<": "less than",
    ">": "more than",
    "≤": "at most",
    "<=": "at most",
    "≥": "at least",
    ">=": "at least",
    "~": "about",
    "≈": "about",
    "≠": "is not",
    "#": "number",
    "@": "at",
}
_UNITS = {
    "px": "pixels",
    "ms": "milliseconds",
    "s": "seconds",
    "kb": "kilobytes",
    "mb": "megabytes",
    "fps": "frames a second",
}
_ARROWS = "↑↓⇡⇣▲▼"
# Element names said as words when a label writes one on its own ("in a p:" is "in a paragraph").
_TAGS = {
    "p": "paragraph",
    "ul": "list",
    "ol": "ordered list",
    "li": "list item",
    "img": "image",
    "div": "div",
    "td": "table cell",
    "tr": "table row",
    "h1": "heading one",
    "h2": "heading two",
    "h3": "heading three",
}


def speakable(word: str) -> str:
    """A written word as the voice should say it: symbols in words ("2×16" is "2 times 16", "=" is "equals"),
    dotted and dashed names apart ("article.card" is "article dot card"), units spelled ("320px"), marks not
    said at all ("·", "|", "↑")."""
    w = word.strip()
    if not w or _SEPARATOR.fullmatch(w) or all(c in _ARROWS for c in w):
        return ""
    if w in _SYMBOLS and w != "x":
        return _SYMBOLS[w]
    # Quotes and brackets around a key or a value, and what ends it: '"tweets": {' is "tweets".
    w = w.strip(_ARROWS + "()[]{}\"'`:,;")
    if not w:
        return ""
    if w in _TAGS:
        return _TAGS[w]
    # An endpoint's path and query: "/api/tweets/:id" is "api tweets id", "?limit=10&cursor=c1" is "with
    # limit 10 and cursor c1".
    if w.startswith("/") or w.startswith("?"):
        path, _, query = w.partition("?")
        said = " ".join(seg.lstrip(":") for seg in path.split("/") if seg)
        if query:
            said += " with " + " and ".join(" ".join(kv.partition("=")[::2]).strip() for kv in query.split("&"))
        return re.sub(r"\s+", " ", said).strip()
    # Selectors: an id or an attribute is said as its name ("ul#list" is "ul list", "[data-id=x]" is "data id x").
    w = re.sub(r"(?<=\w)#(?=\w)", " ", w)
    w = re.sub(r"[\[\]]", " ", w)
    w = re.sub(r"(?<=[A-Za-z])=(?=\w)", " ", w)
    # Units after a number.
    w = re.sub(r"(?i)(\d)(px|ms|kb|mb|fps|s)\b", lambda m: f"{m.group(1)} {_UNITS[m.group(2).lower()]}", w)
    # Symbols inside a word: 2×16, a+b, 10→20, 3x.
    w = re.sub(r"(?<=\d)[x×](?=\d)", " times ", w)
    for sym in ("->", "=>", "<-", "<=", ">=", "→", "←", "×", "=", "+", "≤", "≥", "≈", "≠", "%", "&", "~"):
        if sym in w:
            w = w.replace(sym, f" {_SYMBOLS[sym]} ")
    # Names: dots between letters are said, dashes and underscores are pauses.
    w = re.sub(r"(?<=\w)\.(?=\w)", " dot ", w)
    w = re.sub(r"^\.(?=[A-Za-z])", "dot ", w)
    w = re.sub(r"(?<=\w)[-_/](?=\w)", " ", w)
    w = re.sub(r"[|·•]", " ", w)
    return re.sub(r"\s+", " ", w).strip(" ,;:")


def pen_items(ops: list[Any]) -> list[PenItem]:
    """Each operation of a drawing with its pen time and its label's words (none for a mark with no label)."""
    items: list[PenItem] = []
    for i, op in enumerate(ops):
        kind = op.get("op") if isinstance(op, dict) else None
        text = ""
        if kind in ("box", "region", "rename", "arrow"):
            text = str(op.get("label") or "")
        elif kind == "note":
            text = str(op.get("text") or "")
        written = text.split()
        spoken = [speakable(w) for w in written]
        # A unit written apart from its number ("780 px") is said in full too.
        for k in range(1, len(written)):
            unit = written[k].strip(",.;:").lower()
            if unit in _UNITS and re.search(r"\d$", written[k - 1].rstrip(",.;:")):
                spoken[k] = _UNITS[unit]
        items.append(PenItem(index=i, lead_ms=LEAD_MS.get(str(kind), 500), written=written, spoken=spoken))
    return items


# ---------------------------------------------------------------------------------------------------------
# When each word is said


def _levels(pcm: bytes, rate: int) -> list[float]:
    """The loudness (RMS) of each 10 ms frame of 16-bit mono audio."""
    samples = array("h", pcm[: len(pcm) - len(pcm) % 2])
    step = max(1, rate * FRAME_MS // 1000)
    out: list[float] = []
    for at in range(0, len(samples), step):
        chunk = samples[at : at + step]
        out.append((sum(s * s for s in chunk) / len(chunk)) ** 0.5)
    return out


def voiced_runs(pcm: bytes, rate: int) -> list[tuple[int, int]]:
    """The stretches of speech in the audio, in ms, split where it is quiet for GAP_MS or more."""
    levels = _levels(pcm, rate)
    if not levels:
        return []
    threshold = max(VOICED_FLOOR, max(levels) * VOICED_SHARE)
    runs: list[list[int]] = []
    for k, level in enumerate(levels):
        if level < threshold:
            continue
        start = k * FRAME_MS
        if runs and start - runs[-1][1] < GAP_MS:
            runs[-1][1] = start + FRAME_MS
        else:
            runs.append([start, start + FRAME_MS])
    return [(a, b) for a, b in runs]


def _syllables(word: str) -> int:
    """About how long a word takes to say: its vowel groups (digits count as two each), at least one."""
    w = word.lower()
    n = len(re.findall(r"[aeiouy]+", w)) + 2 * len(re.findall(r"\d", w))
    return max(1, n)


def _share(start: float, end: float, weights: list[int]) -> list[list[int]]:
    """[start, end] cut into one span per weight, each as long as its share."""
    whole = sum(weights)
    spans, at = [], float(start)
    for w in weights:
        nxt = at + (end - start) * w / whole
        spans.append([round(at), round(nxt)])
        at = nxt
    return spans


def _align(runs: list[tuple[int, int]], weights: list[int]) -> list[list[int]]:
    """The words' spans when the voiced runs are not one per word: the runs and the words are cut into matching
    groups, several runs for one word (a word said with a break in it) or one run for several words (words said
    together), choosing the cut whose groups last most nearly as long as their words take to say."""
    n, m = len(runs), len(weights)
    first, last = runs[0][0], runs[-1][1]
    length = max(1, last - first)
    whole = sum(weights)
    wsum = [0]
    for w in weights:
        wsum.append(wsum[-1] + w)
    inf = float("inf")
    cost = [[inf] * (m + 1) for _ in range(n + 1)]
    back: list[list[tuple[int, int] | None]] = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            # Runs a..i-1 for word j-1, or run i-1 for words b..j-1.
            options = [(a, j - 1) for a in range(i)] + [(i - 1, b) for b in range(j - 1)]
            for a, b in options:
                if cost[a][b] == inf:
                    continue
                share = (runs[i - 1][1] - runs[a][0]) / length - (wsum[j] - wsum[b]) / whole
                c = cost[a][b] + share * share
                if c < cost[i][j]:
                    cost[i][j], back[i][j] = c, (a, b)
    groups: list[tuple[int, int, int, int]] = []
    i, j = n, m
    while i or j:
        prev = back[i][j]
        assert prev is not None
        groups.append((prev[0], i, prev[1], j))
        i, j = prev
    spans: list[list[int]] = []
    for a, i, b, j in reversed(groups):
        spans.extend(_share(runs[a][0], runs[i - 1][1], weights[b:j]))
    return spans


def _balance(spans: list[list[int]], least: list[int]) -> list[list[int]]:
    """The spans laid end to end again over the same stretch, each at least its least (when the stretch has room
    for them all), the time taken from the longest."""
    # First into the quiet after a word, up to the next word.
    spans = [list(s) for s in spans]
    for k in range(len(spans) - 1):
        if spans[k][1] - spans[k][0] < least[k]:
            spans[k][1] = min(spans[k + 1][0], spans[k][0] + least[k])
    start, end = spans[0][0], spans[-1][1]
    room = end - start
    lengths = [b - a for a, b in spans]
    if room <= 0 or sum(least) > room or all(n >= k for n, k in zip(lengths, least, strict=True)):
        return spans
    for _ in range(4):
        lengths = [max(n, k) for n, k in zip(lengths, least, strict=True)]
        over = sum(lengths) - room
        spare = [n - k for n, k in zip(lengths, least, strict=True)]
        if over <= 0 or not sum(spare):
            break
        lengths = [n - over * p / sum(spare) for n, p in zip(lengths, spare, strict=True)]
    out, at = [], float(start)
    for n in lengths:
        out.append([round(at), round(at + n)])
        at += n
    out[-1][1] = end
    return out


def word_windows(written: list[str], spoken: list[str], pcm: bytes, rate: int) -> list[list[int]]:
    """When each written word is said, as [start, end] in ms from the start of the label's audio.

    The speech is found in the audio (its voiced runs). When the runs are as many as the words said, each word
    is its run; otherwise runs and words are matched in groups by how long each word takes to say (`_align`), or,
    with no speech found, the whole audio is shared that way. No word is given less than the pen needs to write
    it legibly (`_balance`). A mark that is not said ("·") is written in the instant between its neighbours.
    """
    total = int(len(pcm) / 2 / max(1, rate) * 1000)
    runs = voiced_runs(pcm, rate)
    said = [k for k, s in enumerate(spoken) if s]
    windows: list[list[int]] = [[0, 0] for _ in written]
    if not written:
        return windows
    if not said:
        return [[0, 0] for _ in written]
    weights = [_syllables(spoken[k]) for k in said]
    if len(runs) == len(said):
        spans = [list(r) for r in runs]
    elif runs:
        spans = _align(runs, weights)
    else:
        spans = _share(0, total, weights)
    spans = _balance(spans, [min(WORD_MIN_MS, CHAR_MIN_MS * len(written[k])) for k in said])
    for k, span in zip(said, spans, strict=True):
        windows[k] = span
    # Unsaid marks: between the word before and the word after.
    last = spans[0][0]
    for k in range(len(written)):
        if spoken[k]:
            last = windows[k][1]
        else:
            windows[k] = [last, last]
    return windows


# ---------------------------------------------------------------------------------------------------------
# The processor


def _message(data: dict[str, Any]) -> dict[str, Any]:
    return RTVI.ServerMessage(data=data).model_dump(exclude_none=True)


class Conductor(FrameProcessor):
    """After the voice, before the output: the pauses and the pen's cues around each label (module doc)."""

    def __init__(self, *, max_hold_secs: float = MAX_HOLD_SECS, clock: Callable[[], float] = time.monotonic, **kwargs):
        super().__init__(**kwargs)
        self._max_hold = max_hold_secs
        self._clock = clock
        self._rate = 24000
        self._mark: PenMarkFrame | None = None  # the label whose audio is held
        self._held: list[Frame] = []
        self._since = 0.0
        self.labels = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            self._mark = None
            self._held = []
            await self.push_frame(frame, direction)
            await self.push_frame(OutputTransportMessageUrgentFrame(message=_message({"kind": "pen", "at": "release"})))
            return
        if isinstance(frame, PauseFrame):
            if self._mark is not None:
                await self._release(self._mark)
            await self._silence(frame.ms)
            return
        if isinstance(frame, PenMarkFrame):
            if frame.phase == "before":
                await self._before(frame)
            else:
                await self._after(frame)
            return
        if isinstance(frame, TTSAudioRawFrame) and frame.sample_rate:
            self._rate = frame.sample_rate
        if self._mark is not None and direction == FrameDirection.DOWNSTREAM and not isinstance(frame, SystemFrame):
            self._held.append(frame)
            if self._clock() - self._since > self._max_hold:
                await self._release(self._mark)
            return
        await self.push_frame(frame, direction)

    async def _before(self, mark: PenMarkFrame) -> None:
        if self._mark is not None:
            await self._release(self._mark)
        item = mark.item
        await self._cue({"at": "shape", "ref": mark.ref, "i": item.index, "ms": item.lead_ms})
        await self._silence(item.lead_ms)
        if item.speech:
            self._mark = mark
            self._held = []
            self._since = self._clock()

    async def _after(self, mark: PenMarkFrame) -> None:
        if self._mark is not None and self._mark.ref == mark.ref and self._mark.item.index == mark.item.index:
            await self._release(self._mark)
        await self._silence(mark.item.tail_ms)

    async def _release(self, mark: PenMarkFrame) -> None:
        """The label's audio, measured: the write cue, then the audio right behind it."""
        held, self._held, self._mark = self._held, [], None
        pcm = b"".join(f.audio for f in held if isinstance(f, TTSAudioRawFrame))
        item = mark.item
        windows = word_windows(item.written, item.spoken, pcm, self._rate)
        await self._cue({"at": "write", "ref": mark.ref, "i": item.index, "words": windows})
        self.labels += 1
        logger.info(
            "voice pen {}#{} {!r} audio={}ms words={}",
            mark.ref,
            item.index,
            item.speech,
            len(pcm) * 500 // self._rate,
            windows,
        )
        for f in held:
            if isinstance(f, TTSTextFrame):
                f.pen_label = True  # type: ignore[attr-defined]  # not the reply's words (UsageObserver)
            await self.push_frame(f)

    async def _cue(self, data: dict[str, Any]) -> None:
        await self.push_frame(OutputTransportMessageFrame(message=_message({"kind": "pen", **data})))

    async def _silence(self, ms: int) -> None:
        if ms <= 0:
            return
        samples = self._rate * ms // 1000
        await self.push_frame(TTSAudioRawFrame(audio=b"\x00\x00" * samples, sample_rate=self._rate, num_channels=1))
