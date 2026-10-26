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
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# After the candidate stops talking, how much longer a lesson's next move waits: their turn is still being
# transcribed and sent, and the move must not start ahead of it (it would answer them after itself).
AFTER_LEARNER_SECS = 3.0


class IdleTimer:
    """The rungs' clock: armed when the interviewer falls silent, disarmed when anyone speaks.

    A coach lesson drives itself (docs/coach-mode.md): with `self_drive` set (seconds, from the
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

    def arm(self, extra: float = 0.0) -> None:
        """Starts the clock; `extra` seconds more before a lesson's next move."""
        self.disarm()
        self.fired = []
        self._timer = asyncio.get_event_loop().create_task(self._run(extra))

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

    async def _run(self, extra: float = 0.0) -> None:
        loop = asyncio.get_event_loop()
        start = loop.time()
        steps: list[tuple[float, int | None]] = [(float(r), r) for r in self._rungs]
        if self.self_drive is not None and self._on_continue is not None:
            steps.append((self.self_drive + extra, None))
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
    """Arms the timer when the bot stops speaking, disarms it when the candidate or the bot starts.

    The bot stopping because the candidate cut in arms nothing: they are talking. When they stop, the clock
    starts with AFTER_LEARNER_SECS more before a lesson's next move, so their turn gets there first.
    """

    def __init__(self, *, timer: IdleTimer, **kwargs):
        super().__init__(**kwargs)
        self.timer = timer
        self.learner_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStoppedSpeakingFrame):
            if not self.learner_speaking:
                self.timer.arm()
        elif isinstance(frame, UserStartedSpeakingFrame):
            self.learner_speaking = True
            self.timer.disarm()
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.learner_speaking = False
            self.timer.arm(extra=AFTER_LEARNER_SECS)
        elif isinstance(frame, BotStartedSpeakingFrame | EndFrame | CancelFrame):
            self.timer.disarm()
        await self.push_frame(frame, direction)
