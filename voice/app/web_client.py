"""The web tier's internal interview routes, as the pipeline calls them (design section 6, "voice → web").

Every call carries the shared bearer. After `attach`, every call carries the pipeline's epoch; the web
answers 409 `stale_epoch` when another pipeline has taken the session, and the caller stops.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

import httpx


class WebError(Exception):
    """A refused call: the interview's error body (code, status, message)."""

    def __init__(self, status: int, code: str, message: str, detail: dict[str, Any] | None = None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail or {}

    @property
    def stale(self) -> bool:
        """Another pipeline holds the session, or its voice part is over: this one stops."""
        return self.code in ("stale_epoch", "voice_ended", "not_found", "finished")


@dataclass
class State:
    """What the pipeline runs on, as the web last said it (PipelineView)."""

    epoch: int
    seq: int
    stage_index: int
    stage: dict[str, Any]
    say: str
    resumed: bool
    closed: str | None
    ends_at: str
    exchanges_left: int
    audio_opt_in: bool
    idle_rungs: list[int]
    # A mock interview or a coach lesson (docs/coach-mode.md).
    kind: str = "interview"
    # A lesson's self-drive: seconds of silence after the coach's last word before the pipeline asks for
    # the next move (a `continue` turn). None: the interviewer waits for the candidate; a closed session.
    self_drive: float | None = None

    @staticmethod
    def parse(d: dict[str, Any]) -> State:
        return State(
            epoch=int(d.get("epoch", 0)),
            seq=int(d.get("seq", 0)),
            stage_index=int(d.get("stageIndex", 0)),
            stage=dict(d.get("stage") or {}),
            say=str(d.get("say") or ""),
            resumed=bool(d.get("resumed")),
            closed=d.get("closed"),
            ends_at=str(d.get("endsAt") or ""),
            exchanges_left=int(d.get("exchangesLeft", 0)),
            audio_opt_in=bool(d.get("audioOptIn")),
            idle_rungs=[int(r) for r in d.get("idleRungs", [20, 35, 60, 120])],
            kind=str(d.get("kind") or "interview"),
            self_drive=float(d["selfDrive"]) if d.get("selfDrive") is not None else None,
        )


def _error(res: httpx.Response) -> WebError:
    try:
        body = res.json()
    except ValueError:
        body = {}
    return WebError(
        res.status_code,
        str(body.get("code") or "upstream"),
        str(body.get("error") or res.text[:200]),
        {k: v for k, v in body.items() if k not in ("code", "error", "status", "retryAfter")},
    )


async def sse_events(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str, Any]]:
    """Parses a text/event-stream into (event, data) pairs; data is JSON when it parses."""
    event = "message"
    data: list[str] = []
    async for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                text = "\n".join(data)
                try:
                    yield event, json.loads(text)
                except ValueError:
                    yield event, text
            event, data = "message", []
            continue
        if line.startswith(":"):
            continue
        key, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if key == "event":
            event = value
        elif key == "data":
            data.append(value)


class WebClient:
    """One client per task, shared by its pipelines."""

    def __init__(self, base_url: str, secret: str, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(
            base_url=base_url, headers={"Authorization": f"Bearer {secret}"}, timeout=httpx.Timeout(10.0, read=120.0)
        )
        self._own = client is None

    async def aclose(self) -> None:
        if self._own:
            await self._client.aclose()

    async def _post(self, sid: str, action: str, body: dict[str, Any]) -> dict[str, Any]:
        res = await self._client.post(f"/api/internal/interview/{sid}/{action}", json=body)
        if res.status_code >= 400:
            raise _error(res)
        return res.json() if res.content else {}

    async def attach(self, sid: str, token: str, task: str) -> State:
        return State.parse(await self._post(sid, "attach", {"token": token, "task": task}))

    async def turn(
        self,
        sid: str,
        epoch: int,
        seq: int,
        text: str,
        on_delta: Callable[[str], Any],
        *,
        kind: str = "speech",
        on_draw: Callable[[list[Any], Any], Any] | None = None,
    ) -> State:
        """A spoken candidate turn (or, kind `continue`, a coach lesson's next move with no words): the reply's
        text goes to on_delta as it streams, each drawing (with its anchor: the words before it) to on_draw, and
        the state after it is returned."""
        body: dict[str, Any] = {"epoch": epoch, "seq": seq, "text": text}
        if kind == "continue":
            body["kind"] = "continue"
        async with self._client.stream(
            "POST",
            f"/api/internal/interview/{sid}/turns",
            json=body,
            headers={"Accept": "text/event-stream"},
        ) as res:
            if res.status_code >= 400:
                await res.aread()
                raise _error(res)
            if not res.headers.get("content-type", "").startswith("text/event-stream"):
                await res.aread()
                return State.parse(res.json().get("state") or {})
            async for event, data in sse_events(res.aiter_lines()):
                if event == "delta" and isinstance(data, dict) and isinstance(data.get("text"), str):
                    r = on_delta(data["text"])
                    if hasattr(r, "__await__"):
                        await r
                elif event == "draw" and isinstance(data, dict) and on_draw and isinstance(data.get("ops"), list):
                    r = on_draw(data["ops"], data.get("anchor"))
                    if hasattr(r, "__await__"):
                        await r
                elif event == "done" and isinstance(data, dict):
                    return State.parse(data.get("state") or {})
                elif event == "error" and isinstance(data, dict):
                    raise WebError(
                        int(data.get("status") or 502),
                        str(data.get("code") or "upstream"),
                        str(data.get("error") or "reply failed"),
                    )
        raise WebError(502, "cut_off", "The reply stream ended early.")

    async def speculate(self, sid: str, epoch: int, text: str) -> bool:
        """The turn as heard so far, before it is confirmed: the web starts the reply on it (or not)."""
        out = await self._post(sid, "turns", {"epoch": epoch, "text": text, "speculative": True})
        return bool(out.get("started"))

    async def played(self, sid: str, epoch: int, spoken: str) -> None:
        await self._post(sid, "played", {"epoch": epoch, "spoken": spoken})

    async def advance(self, sid: str, epoch: int, from_index: int) -> State:
        return State.parse(await self._post(sid, "advance", {"epoch": epoch, "from": from_index}))

    async def idle(self, sid: str, epoch: int, rung: int) -> State:
        return State.parse(await self._post(sid, "idle", {"epoch": epoch, "rung": rung}))

    async def heartbeat(
        self, sid: str, epoch: int, stt_seconds: float, tts_chars: int, degraded: list[str]
    ) -> str | None:
        """Renews the lease and charges the speech; returns why the session stopped taking turns, or None."""
        out = await self._post(
            sid,
            "heartbeat",
            {"epoch": epoch, "sttSeconds": round(stt_seconds, 1), "ttsChars": tts_chars, "degraded": degraded},
        )
        closed = out.get("closed")
        return str(closed) if closed else None

    async def detach(self, sid: str, epoch: int, reason: str) -> None:
        await self._post(sid, "detach", {"epoch": epoch, "reason": reason})
