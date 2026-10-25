"""The interview-voice service (design section 6): a small HTTP face the web tier talks to, over a supervisor
of Pipecat pipelines. Every route but the probes needs `Authorization: Bearer INTERVIEW_VOICE_SECRET`.

  POST   /sessions         {sid, attach, room: {url, token}, language, audioOptIn, plannedMinutes}
                           starts a pipeline: 202 {task}; 503 when the task has no slot
  DELETE /sessions/{sid}   stops the session's pipeline (the candidate ended the voice part): 200, or 404
  GET    /health           200 while the process is up
  GET    /ready            200 with capacity, 503 while draining or full
  GET    /sessions/{sid}   200 while the pipeline runs here, 404 otherwise (bearer)
"""

from __future__ import annotations

import asyncio
import hmac
import signal
import sys
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger

from app.config import Settings
from app.config import settings as load_settings
from app.supervisor import Full, Supervisor
from app.web_client import WebClient
from bot.run import SessionSpec


async def drain_then_exit(sup: Supervisor, *, exit: Callable[[], None] | None = None) -> None:
    """SIGTERM: park the running sessions, then leave. Taking over SIGTERM from uvicorn means its own
    shutdown no longer runs on the signal, so once drained the process raises SIGINT at itself (which
    uvicorn still handles) instead of lingering until the platform's SIGKILL."""
    await sup.drain()
    (exit or (lambda: signal.raise_signal(signal.SIGINT)))()


def create_app(settings: Settings | None = None, supervisor: Supervisor | None = None) -> FastAPI:
    cfg = settings or load_settings()
    problems = cfg.problems()
    if problems and supervisor is None:
        for p in problems:
            logger.error("config: {}", p)
        raise SystemExit(2)

    web = WebClient(cfg.web_url, cfg.secret)
    sup = supervisor or Supervisor(cfg, web)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        loop = asyncio.get_running_loop()

        def on_term():
            logger.info("SIGTERM: draining")
            asyncio.ensure_future(drain_then_exit(sup))

        try:
            loop.add_signal_handler(signal.SIGTERM, on_term)
        except (NotImplementedError, RuntimeError):
            pass
        yield
        await sup.drain(grace_secs=30)
        await web.aclose()

    app = FastAPI(title="interview-voice", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.supervisor = sup

    def authed(request: Request) -> None:
        header = request.headers.get("authorization", "")
        given = header[7:].strip() if header.startswith("Bearer ") else ""
        if not given or not hmac.compare_digest(given.encode(), cfg.secret.encode()):
            raise HTTPException(status_code=404, detail="Not found")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True}

    @app.get("/ready")
    async def ready() -> JSONResponse:
        body = {
            "ok": not sup.draining and sup.capacity > 0,
            "active": sup.active,
            "capacity": sup.capacity,
            "draining": sup.draining,
        }
        return JSONResponse(body, status_code=200 if body["ok"] else 503)

    @app.post("/sessions", dependencies=[Depends(authed)], status_code=202)
    async def start(body: dict[str, Any]) -> dict[str, Any]:
        try:
            spec = SessionSpec.parse(body)
        except (KeyError, TypeError, ValueError) as err:
            raise HTTPException(status_code=400, detail=f"bad session: {err}") from err
        try:
            sup.start(spec)
        except Full as err:
            raise HTTPException(status_code=503, detail="no capacity") from err
        return {"task": sup.task_id}

    @app.get("/sessions/{sid}", dependencies=[Depends(authed)])
    async def running(sid: str) -> dict[str, Any]:
        """200 while the pipeline runs here; 404 when it does not (a crash, a restart: the lease is dead)."""
        if not sup.has(sid):
            raise HTTPException(status_code=404, detail="no such session")
        return {"running": True, "task": sup.task_id}

    @app.delete("/sessions/{sid}", dependencies=[Depends(authed)])
    async def stop(sid: str) -> dict[str, Any]:
        if not await sup.stop(sid, "left"):
            raise HTTPException(status_code=404, detail="no such session")
        return {"ok": True}

    return app


def main() -> None:
    import uvicorn

    cfg = load_settings()
    logger.remove()
    logger.add(sys.stderr, level=cfg.log_level, serialize=True)
    uvicorn.run(
        create_app(cfg), host="0.0.0.0", port=cfg.port, log_level=cfg.log_level.lower(), timeout_graceful_shutdown=120
    )


if __name__ == "__main__":
    main()
