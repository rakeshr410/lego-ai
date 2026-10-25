"""The drawing keeps time with the voice (docs/interview/coach-mode.md, phase 5).

The web sends each of the coach's drawings as its element closes in the reply, with an anchor: how many words
of the reply come before it. The voice plays those words later than the text streams, so a drawing sent at once
would land on the board ahead of its sentence. The pacer holds each drawing until the output transport has
played that many words (UsageObserver counts them from the TTSTextFrames the transport pushes: word by word
with Cartesia's timestamps, a sentence at a time with a voice that has none), then sends it to the room over
the call, where the pen draws it. Drawings land in order. When the reply stops playing (its end, or the learner
cutting in), whatever is still held lands at once, so the board agrees with what the coach believes it drew; a
drawing held longer than MAX_HOLD_SECS lands regardless (a voice that reports no words).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

MAX_HOLD_SECS = 20.0
# The voice's word count and the web's differ a little (a hyphenated number, an abbreviation): a word of slack.
SLACK = 1


class DrawPacer:
    def __init__(
        self,
        *,
        spoken_words: Callable[[], int],
        send: Callable[[list[Any]], Awaitable[None]],
        max_hold_secs: float = MAX_HOLD_SECS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._spoken_words = spoken_words
        self._send = send
        self._max_hold = max_hold_secs
        self._clock = clock
        self._held: list[tuple[int, float, list[Any]]] = []  # (words before it, held since, ops)
        self._lock = asyncio.Lock()
        self._watch: asyncio.TimerHandle | None = None
        self.sent = 0
        self.held = 0  # drawings that waited for their words

    @property
    def pending(self) -> int:
        return len(self._held)

    @staticmethod
    def words_of(anchor: Any) -> int:
        if isinstance(anchor, dict):
            w = anchor.get("words")
            if isinstance(w, int | float) and w > 0:
                return int(w)
        return 0

    async def draw(self, ops: list[Any], anchor: Any = None) -> None:
        """A drawing from the web: sent now when its words have played (or it has none), held otherwise."""
        self._held.append((self.words_of(anchor), self._clock(), ops))
        await self._release(waited=False)
        if self._held and self._watch is None:
            loop = asyncio.get_running_loop()
            self._watch = loop.call_later(self._max_hold + 0.05, lambda: loop.create_task(self._release(waited=True)))

    async def spoken(self) -> None:
        """A word (or a sentence) of the reply played: a held drawing whose words are out goes."""
        if self._held:
            await self._release(waited=True)

    async def flush(self) -> None:
        """The reply stopped playing: everything still held lands."""
        async with self._lock:
            held, self._held = self._held, []
            self._clear_watch()
            for _, _, ops in held:
                await self._send(ops)
                self.sent += 1

    async def _release(self, *, waited: bool) -> None:
        async with self._lock:
            while self._held:
                words, since, ops = self._held[0]
                due = self._spoken_words() + SLACK >= words or self._clock() - since >= self._max_hold
                if not due:
                    break
                self._held.pop(0)
                if waited:
                    self.held += 1
                await self._send(ops)
                self.sent += 1
            if not self._held:
                self._clear_watch()

    def _clear_watch(self) -> None:
        if self._watch is not None:
            self._watch.cancel()
            self._watch = None
