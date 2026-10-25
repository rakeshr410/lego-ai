"""The attach waits out a `busy` session (the web still holds the session's lock while it starts this
pipeline); any other refusal is final."""

import httpx
import pytest

import bot.run as run
from app.web_client import WebClient, WebError
from bot.run import SessionSpec, attach_with_retry
from tests.conftest import SECRET, FakeWeb

SPEC = SessionSpec(sid="s1", attach="good-token", room_url="https://x.daily.co/r", room_token="t")


def client_for(fake: FakeWeb, refuse_first: list[tuple[int, str]]) -> WebClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/attach") and refuse_first:
            status, code = refuse_first.pop(0)
            return httpx.Response(status, json={"error": "refused", "code": code, "status": status})
        return fake.handler(request)

    return WebClient(
        "http://web.test",
        SECRET,
        client=httpx.AsyncClient(
            base_url="http://web.test",
            headers={"Authorization": f"Bearer {SECRET}"},
            transport=httpx.MockTransport(handler),
        ),
    )


@pytest.mark.asyncio
async def test_attach_waits_out_a_busy_session(fake_web: FakeWeb, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run, "ATTACH_BUSY_WAIT_SECS", 0)
    web = client_for(fake_web, [(409, "busy"), (409, "busy")])
    state = await attach_with_retry(web, SPEC, "task-1")
    assert state.epoch == fake_web.epoch
    assert [c[1] for c in fake_web.calls] == ["attach"]


@pytest.mark.asyncio
async def test_attach_gives_up_on_any_other_refusal_and_after_the_last_try(
    fake_web: FakeWeb, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(run, "ATTACH_BUSY_WAIT_SECS", 0)
    monkeypatch.setattr(run, "ATTACH_BUSY_TRIES", 3)
    with pytest.raises(WebError) as err:
        await attach_with_retry(client_for(fake_web, [(409, "stale_epoch")]), SPEC, "task-1")
    assert err.value.code == "stale_epoch"
    with pytest.raises(WebError) as err:
        await attach_with_retry(client_for(fake_web, [(409, "busy")] * 3), SPEC, "task-1")
    assert err.value.code == "busy"
    assert fake_web.calls == []
