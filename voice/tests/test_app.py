from __future__ import annotations

import asyncio

import httpx
import pytest

from app.main import create_app, drain_then_exit
from app.supervisor import Full, Supervisor
from bot.run import SessionRun, SessionSpec
from tests.conftest import SECRET

SPEC = {
    "sid": "a" * 24,
    "attach": "good-token",
    "room": {"url": "https://x.daily.co/iv-a", "token": "bot-token"},
    "language": "en-IN",
    "audioOptIn": False,
    "plannedMinutes": 45,
}


class FakeRunner:
    """Stands in for run_session: ends when told."""

    def __init__(self):
        self.runs: list[SessionRun] = []
        self.stopped: list[str] = []

    async def __call__(self, spec, settings, web, task_id, run):
        self.runs.append(run)
        done = asyncio.Event()

        async def stop(reason="transport"):
            self.stopped.append(reason)
            run.ended = f"stopped:{reason}"
            done.set()

        run.stop = stop  # type: ignore[method-assign]
        await done.wait()
        return run


@pytest.fixture
def runner():
    return FakeRunner()


@pytest.fixture
def supervisor(settings, web, runner):
    return Supervisor(settings, web, runner=runner)


@pytest.fixture
async def client(settings, supervisor):
    app = create_app(settings, supervisor)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://voice.test") as c:
        yield c


async def test_sessions_need_the_bearer_and_a_slot(client, supervisor, runner):
    assert (await client.post("/sessions", json=SPEC)).status_code == 404
    assert (await client.post("/sessions", json=SPEC, headers={"Authorization": "Bearer nope"})).status_code == 404
    auth = {"Authorization": f"Bearer {SECRET}"}
    r = await client.post("/sessions", json=SPEC, headers=auth)
    assert r.status_code == 202 and r.json()["task"] == supervisor.task_id
    await asyncio.sleep(0)
    assert supervisor.active == 1
    # The same session again keeps the running pipeline.
    assert (await client.post("/sessions", json=SPEC, headers=auth)).status_code == 202
    assert supervisor.active == 1
    assert (await client.post("/sessions", json={**SPEC, "sid": "b" * 24}, headers=auth)).status_code == 202
    assert (await client.post("/sessions", json={**SPEC, "sid": "c" * 24}, headers=auth)).status_code == 503
    ready = await client.get("/ready")
    assert ready.status_code == 503 and ready.json()["active"] == 2
    assert (await client.post("/sessions", json={"sid": "d" * 24}, headers=auth)).status_code == 400
    # Stopping one frees its slot; a session that is not here is a 404.
    assert (await client.delete(f"/sessions/{'a' * 24}", headers=auth)).status_code == 200
    assert runner.stopped == ["left"]
    assert (await client.delete(f"/sessions/{'a' * 24}", headers=auth)).status_code == 404
    assert (await client.get("/ready")).status_code == 200
    assert (await client.get("/health")).json() == {"ok": True}


async def test_draining_parks_every_session_and_refuses_new_ones(settings, web, runner):
    sup = Supervisor(settings, web, runner=runner)
    sup.start(SessionSpec.parse(SPEC))
    sup.start(SessionSpec.parse({**SPEC, "sid": "b" * 24}))
    await asyncio.sleep(0)
    await sup.drain(grace_secs=1)
    assert sorted(runner.stopped) == ["transport", "transport"]
    assert sup.active == 0 and sup.capacity == 0
    with pytest.raises(Full):
        sup.start(SessionSpec.parse({**SPEC, "sid": "c" * 24}))


async def test_the_web_can_ask_whether_a_pipeline_runs_here(client, supervisor):
    auth = {"Authorization": f"Bearer {SECRET}"}
    sid = SPEC["sid"]
    assert (await client.get(f"/sessions/{sid}")).status_code == 404  # no bearer
    assert (await client.get(f"/sessions/{sid}", headers=auth)).status_code == 404  # not running
    assert (await client.post("/sessions", json=SPEC, headers=auth)).status_code == 202
    await asyncio.sleep(0)
    r = await client.get(f"/sessions/{sid}", headers=auth)
    assert r.status_code == 200 and r.json() == {"running": True, "task": supervisor.task_id}
    assert (await client.delete(f"/sessions/{sid}", headers=auth)).status_code == 200
    await asyncio.sleep(0)
    assert (await client.get(f"/sessions/{sid}", headers=auth)).status_code == 404


async def test_sigterm_parks_the_sessions_and_then_exits(client, supervisor, runner):
    auth = {"Authorization": f"Bearer {SECRET}"}
    assert (await client.post("/sessions", json=SPEC, headers=auth)).status_code == 202
    await asyncio.sleep(0)
    exits = []
    await drain_then_exit(supervisor, exit=lambda: exits.append(True))
    assert runner.stopped == ["transport"]
    assert supervisor.draining and supervisor.active == 0
    assert exits == [True]
