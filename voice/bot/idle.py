"""The candidate's silence (design section 5 and 6): after the interviewer's last word, with nothing from the
candidate, the room's rungs (20, 35, 60, 120 s) are reported to the web, which decides what the interviewer
says (a canned "Take your time", a rephrased question, a hint), and the pipeline speaks it. Each rung fires
once per quiet spell; any speech from either side resets the clock. Nothing is ever advanced on silence.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class IdleTimer:
    """The rungs' clock: armed when the interviewer falls silent, disarmed when anyone speaks.

    A coach lesson drives itself (docs/interview/coach-mode.md): with `self_drive` set (seconds, from the
    web's state after each turn), the clock calls `on_continue` once at that mark instead of running on;
    the move it fetches is spoken, and the next silence arms the clock again.
    """

    def __init__(
        self,
        rungs: list[int],
        on_rung: Callable[[int], Awaitable[None]],
        sleep=asyncio.sleep,
        on_continue: Callable[[], Awaitable[None]] | None = None,
    ):
        self._rungs = sorted(rungs)
        self._on_rung = on_rung
        self._on_continue = on_continue
        self._sleep = sleep
        self._timer: asyncio.Task | None = None
        self.held_until: float = 0.0
        self.self_drive: float | None = None
        self.fired: list[int] = []
        self.continued = 0

    def arm(self) -> None:
        self.disarm()
        self.fired = []
        self._timer = asyncio.get_event_loop().create_task(self._run())

    def disarm(self) -> None:
        if self._timer and not self._timer.done():
            self._timer.cancel()
        self._timer = None

    def hold(self, seconds: float) -> None:
        """The candidate asked for time: no rung for this long."""
        self.held_until = asyncio.get_event_loop().time() + seconds
        self.disarm()

    @property
    def armed(self) -> bool:
        return self._timer is not None and not self._timer.done()

    async def _run(self) -> None:
        loop = asyncio.get_event_loop()
        start = loop.time()
        steps: list[tuple[float, int | None]] = [(float(r), r) for r in self._rungs]
        if self.self_drive is not None and self._on_continue is not None:
            steps.append((self.self_drive, None))
        steps.sort(key=lambda s: s[0])
        try:
            for at, rung in steps:
                await self._sleep(max(0.0, start + at - loop.time()))
                if loop.time() < self.held_until:
                    return
                if rung is None:
                    self.continued += 1
                    await self._on_continue()  # type: ignore[misc]
                    return
                self.fired.append(rung)
                await self._on_rung(rung)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a rung that fails must not kill the timer's owner
            return


class IdleGate(FrameProcessor):
    """Arms the timer when the bot stops speaking, disarms it when the candidate or the bot starts."""

    def __init__(self, *, timer: IdleTimer, **kwargs):
        super().__init__(**kwargs)
        self.timer = timer

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStoppedSpeakingFrame):
            self.timer.arm()
        elif isinstance(frame, UserStartedSpeakingFrame | BotStartedSpeakingFrame | EndFrame | CancelFrame):
            self.timer.disarm()
        await self.push_frame(frame, direction)
