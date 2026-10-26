"""The coach's own voice, heard back (design section 6).

On a laptop without headphones the microphone can pick up the speakers, and the browser's echo cancellation
does not always take it all out: the transcriber then hears the coach and the web gets a learner's turn
that nobody said, which the coach answers ("Right idea"). A transcribed fragment is an echo when its words
are the words the voice just played, in the same order: for three words or more, most of its word pairs are
pairs the voice said; a fragment of one or two words is an echo only while the voice is speaking (or just
stopped) and the voice said those words together, since a learner's "yes" or "okay" is a real answer.
"""

from __future__ import annotations

import re
import time
from collections import deque

WORD = re.compile(r"[a-z0-9']+")
# How long the voice's words are held for matching, and how soon after it stops a short fragment may be its echo.
WINDOW_SECS = 12.0
SHORT_SECS = 1.5
# The share of a fragment's word pairs the voice must have said for the fragment to be its echo.
PAIR_SHARE = 0.75


def words(text: str) -> list[str]:
    return WORD.findall(text.lower())


def is_echo(fragment: str, said: str, *, speaking: bool) -> bool:
    heard = words(fragment)
    voice = words(said)
    if not heard or not voice:
        return False
    if len(heard) <= 2:
        if not speaking:
            return False
        n = len(heard)
        return any(voice[i : i + n] == heard for i in range(len(voice) - n + 1))
    pairs = set(zip(voice, voice[1:]))
    mine = list(zip(heard, heard[1:]))
    return sum(p in pairs for p in mine) / len(mine) >= PAIR_SHARE


class VoiceMemory:
    """The words the voice played in the last WINDOW_SECS, and whether it is speaking (or just stopped)."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._words: deque[tuple[float, str]] = deque()
        self._speaking = False
        self._stopped_at: float | None = None

    def played(self, text: str) -> None:
        now = self._clock()
        self._words.append((now, text))
        while self._words and now - self._words[0][0] > WINDOW_SECS:
            self._words.popleft()

    def started(self) -> None:
        self._speaking = True

    def stopped(self) -> None:
        self._speaking = False
        self._stopped_at = self._clock()

    def said(self) -> str:
        now = self._clock()
        return " ".join(t for at, t in self._words if now - at <= WINDOW_SECS)

    def speaking(self) -> bool:
        return self._speaking or (self._stopped_at is not None and self._clock() - self._stopped_at <= SHORT_SECS)

    def echoes(self, fragment: str) -> bool:
        return is_echo(fragment, self.said(), speaking=self.speaking())
