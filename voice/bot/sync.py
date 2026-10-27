"""The heartbeat (design section 6): every few seconds the pipeline tells the web what it has used and
learns whether the session still takes turns. A refused heartbeat (stale epoch) stops the pipeline.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable

from loguru import logger

from app.web_client import WebClient, WebError
from bot.observers import UsageObserver


class Heartbeat:
    def __init__(
        self,
        *,
        web: WebClient,
        sid: str,
        epoch: int,
        usage: UsageObserver,
        period_secs: float,
        on_closed: Callable[[str], Awaitable[None]],
        on_stale: Callable[[WebError], Awaitable[None]],
        stt: str | None = None,
        tts: str | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._web = web
        self._sid = sid
        self._epoch = epoch
        self._usage = usage
        self._period = period_secs
        self._on_closed = on_closed
        self._on_stale = on_stale
        # The speech services in use, for their prices, and when the pipeline joined the room (its minutes are billed).
        self._vendors = {"stt": stt, "tts": tts}
        self._clock = clock
        self._since = clock()
        self._task: asyncio.Task | None = None
        self.beats = 0
        self.misses = 0

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()

    async def once(self) -> str | None:
        closed = await self._web.heartbeat(
            self._sid,
            self._epoch,
            self._usage.stt_seconds,
            self._usage.tts_chars,
            sorted(self._usage.degraded),
            room_seconds=self._clock() - self._since,
            **self._vendors,
        )
        self.beats += 1
        return closed

    async def _run(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._period)
                closed = await self.once()
                if closed:
                    await self._on_closed(closed)
                    return
            except asyncio.CancelledError:
                raise
            except WebError as err:
                if err.stale:
                    await self._on_stale(err)
                    return
                self.misses += 1
                logger.warning("voice heartbeat {} refused: {}", self._sid, err)
            except Exception as err:  # noqa: BLE001 - the web unreachable for a beat: try again
                self.misses += 1
                logger.warning("voice heartbeat {} failed: {}", self._sid, err)
