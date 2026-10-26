"""Fakes shared by the tests: a web tier at httpx's mock transport, and settings with nothing real in them."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.web_client import WebClient

SECRET = "x" * 40


@dataclass
class FakeWeb:
    """The web's internal routes, scripted: what each action answers, and every call it saw."""

    calls: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    epoch: int = 1
    seq: int = 0
    closed: str | None = None
    reply: str = "Who are the users, and on which devices?"
    reply_chunks: list[str] | None = None
    refuse: dict[str, tuple[int, str]] = field(default_factory=dict)
    say: dict[str, str] = field(default_factory=dict)
    delay: Callable[[], Any] | None = None
    # A coach lesson: continues are answered like turns (no seq), with this drawing before the done event.
    kind: str = "interview"
    self_drive: float | None = None
    draw_ops: list[dict[str, Any]] | None = None
    # What the reply says after its drawing, as deltas.
    after_draw: list[str] = field(default_factory=list)
    draw_prelude: bool = False

    def state(self, say: str = "", resumed: bool = False) -> dict[str, Any]:
        return {
            "epoch": self.epoch,
            "seq": self.seq,
            "stageIndex": 0,
            "stage": {"key": "requirements", "title": "Requirements", "minutes": 8, "index": 0, "of": 4},
            "say": say,
            "resumed": resumed,
            "closed": self.closed,
            "endsAt": "2026-10-23T13:00:00.000Z",
            "exchangesLeft": 90 - self.seq,
            "audioOptIn": False,
            "idleRungs": [20, 35, 60, 120] if self.kind == "interview" else [],
            "kind": self.kind,
            "selfDrive": self.self_drive,
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.split("/")
        sid, action = parts[4], parts[5]
        body = json.loads(request.content or b"{}")
        self.calls.append((sid, action, body))
        if request.headers.get("authorization") != f"Bearer {SECRET}":
            return httpx.Response(404, json={"error": "Not found"})
        if action in self.refuse:
            status, code = self.refuse[action]
            return httpx.Response(
                status, json={"error": f"refused {action}", "code": code, "status": status, "retryAfter": None}
            )
        if action != "attach" and body.get("epoch") != self.epoch:
            return httpx.Response(
                409,
                json={"error": "stale", "code": "stale_epoch", "status": 409, "retryAfter": None, "epoch": self.epoch},
            )
        if action == "attach":
            if body.get("token") != "good-token":
                return httpx.Response(
                    404, json={"error": "Unknown session or token.", "code": "not_found", "status": 404}
                )
            return httpx.Response(200, json=self.state(say="Welcome. Tell me about the users.", resumed=self.epoch > 1))
        if action == "turns":
            if body.get("kind") == "continue":
                if self.kind != "coach":
                    return httpx.Response(400, json={"error": "not a lesson", "code": "invalid", "status": 400})
            elif body.get("seq") != self.seq + 1:
                return httpx.Response(
                    409, json={"error": "out of order", "code": "stale_epoch", "status": 409, "seq": self.seq}
                )
            else:
                self.seq += 1
            chunks = self.reply_chunks or [self.reply[: len(self.reply) // 2], self.reply[len(self.reply) // 2 :]]
            lines = []
            for c in chunks:
                lines.append(f"event: delta\ndata: {json.dumps({'text': c})}\n\n")
            if self.draw_ops:
                lines.append(
                    f"event: draw\ndata: {json.dumps({'ops': self.draw_ops, 'anchor': {'words': 0, 'prelude': True} if self.draw_prelude else {'words': 3}})}\n\n"
                )
            for c in self.after_draw:
                lines.append(f"event: delta\ndata: {json.dumps({'text': c})}\n\n")
            lines.append(
                f"event: done\ndata: {json.dumps({'turn': {'role': 'interviewer', 'text': self.reply}, 'state': self.state()})}\n\n"
            )
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="".join(lines).encode())
        if action == "heartbeat":
            return httpx.Response(200, json={"ok": True, "closed": self.closed, "endsAt": "2026-10-23T13:00:00.000Z"})
        if action == "idle":
            return httpx.Response(200, json=self.state(say=self.say.get(str(body.get("rung")), "")))
        if action == "advance":
            return httpx.Response(200, json=self.state(say="Stage two. Let's talk about the high-level design."))
        if action in ("played", "detach"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404, json={"error": "Not found"})


@pytest.fixture
def fake_web() -> FakeWeb:
    return FakeWeb()


@pytest.fixture
def web(fake_web: FakeWeb) -> WebClient:
    client = httpx.AsyncClient(
        base_url="http://web.test",
        headers={"Authorization": f"Bearer {SECRET}"},
        transport=httpx.MockTransport(fake_web.handler),
    )
    return WebClient("http://web.test", SECRET, client=client)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        web_url="http://web.test",
        secret=SECRET,
        deepgram_api_key="dg",
        cartesia_api_key="ca",
        max_sessions=2,
        heartbeat_secs=0.05,
        filler_after_secs=0.05,
        idle_timeout_secs=5,
    )
