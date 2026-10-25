"""The task's pipelines (design section 6, process model): at most `max_sessions` at once, each an asyncio
task; stopped one by one on request, and all together when the task drains (SIGTERM: every session is
parked, and the rooms rejoin on another task).
"""

from __future__ import annotations

import asyncio
import os
import socket

from loguru import logger

from app.config import Settings
from app.web_client import WebClient
from bot.run import SessionRun, SessionSpec, run_session


class Full(Exception):
    pass


class Supervisor:
    def __init__(self, settings: Settings, web: WebClient, runner=run_session):
        self._settings = settings
        self._web = web
        self._runner = runner
        self._runs: dict[str, tuple[SessionRun, asyncio.Task]] = {}
        self.draining = False
        self.task_id = os.environ.get("ECS_TASK_ID") or f"{socket.gethostname()}-{os.getpid()}"

    @property
    def active(self) -> int:
        return len(self._runs)

    def has(self, sid: str) -> bool:
        """Whether this task runs the session's pipeline (the web asks before trusting a lease)."""
        return sid in self._runs

    @property
    def capacity(self) -> int:
        return 0 if self.draining else max(0, self._settings.max_sessions - self.active)

    def start(self, spec: SessionSpec) -> SessionRun:
        if self.draining or self.active >= self._settings.max_sessions:
            raise Full()
        if spec.sid in self._runs:
            # The same session again (the web retried): the running pipeline keeps it.
            return self._runs[spec.sid][0]
        run = SessionRun(spec=spec, task_id=self.task_id)
        task = asyncio.create_task(self._run(spec, run))
        self._runs[spec.sid] = (run, task)
        return run

    async def _run(self, spec: SessionSpec, run: SessionRun) -> None:
        try:
            await self._runner(spec, self._settings, self._web, self.task_id, run)
        except Exception as err:  # noqa: BLE001
            run.ended = run.ended or f"crashed:{type(err).__name__}"
            logger.exception("voice pipeline {} crashed: {}", spec.sid, err)
        finally:
            self._runs.pop(spec.sid, None)

    async def stop(self, sid: str, reason: str = "left") -> bool:
        entry = self._runs.get(sid)
        if not entry:
            return False
        run, task = entry
        await run.stop(reason)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except (TimeoutError, asyncio.CancelledError):
            task.cancel()
        return True

    async def drain(self, grace_secs: float = 90.0) -> None:
        """Stops taking sessions, parks the running ones, waits for them to end."""
        self.draining = True
        tasks = [t for _, t in self._runs.values()]
        for run, _ in list(self._runs.values()):
            await run.stop("transport")
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=grace_secs)
            for t in pending:
                t.cancel()
        logger.info("voice supervisor drained ({} sessions)", len(tasks))
