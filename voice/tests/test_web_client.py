from __future__ import annotations

import httpx
import pytest

from app.web_client import WebError, sse_events


async def _lines(text: str):
    for line in text.split("\n"):
        yield line


async def test_sse_parses_events_and_json():
    out = [
        e
        async for e in sse_events(
            _lines(
                'event: delta\ndata: {"text": "Hi"}\n\n: comment\nevent: done\ndata: {"a": 1}\ndata: \n\nevent: raw\ndata: plain\n\n'
            )
        )
    ]
    assert out == [("delta", {"text": "Hi"}), ("done", {"a": 1}), ("raw", "plain")]


async def test_attach_turn_and_heartbeat(web, fake_web):
    state = await web.attach("a" * 24, "good-token", "task-1")
    assert state.epoch == 1 and state.seq == 0 and state.say.startswith("Welcome")
    got: list[str] = []
    after = await web.turn("a" * 24, 1, 1, "Mobile web first.", got.append)
    assert "".join(got) == fake_web.reply
    assert after.seq == 1 and after.exchanges_left == 89
    assert await web.heartbeat("a" * 24, 1, 12.34, 500, ["tts"]) is None
    fake_web.closed = "time"
    assert await web.heartbeat("a" * 24, 1, 12.34, 500, []) == "time"
    assert fake_web.calls[-1][2] == {"epoch": 1, "sttSeconds": 12.3, "ttsChars": 500, "degraded": []}


async def test_refusals_carry_the_interview_code(web, fake_web):
    with pytest.raises(WebError) as err:
        await web.attach("a" * 24, "bad", "task-1")
    assert err.value.code == "not_found" and err.value.stale
    with pytest.raises(WebError) as err:
        await web.turn("a" * 24, 2, 1, "hello", lambda _: None)
    assert err.value.code == "stale_epoch" and err.value.status == 409
    fake_web.refuse["turns"] = (409, "turns")
    with pytest.raises(WebError) as err:
        await web.turn("a" * 24, 1, 1, "hello", lambda _: None)
    assert err.value.code == "turns" and not err.value.stale


async def test_a_turn_stream_that_errors_mid_way(web):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b'event: delta\ndata: {"text": "Wh"}\n\nevent: error\ndata: {"error": "budget", "code": "budget", "status": 503}\n\n',
        )

    web._client._transport = httpx.MockTransport(handler)
    with pytest.raises(WebError) as err:
        await web.turn("a" * 24, 1, 1, "hello", lambda _: None)
    assert err.value.code == "budget"


async def test_a_lessons_state_and_continue_turn(web, fake_web):
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.draw_ops = [{"op": "box", "label": "Client"}]
    state = await web.attach("a" * 24, "good-token", "task-1")
    assert state.kind == "coach" and state.self_drive == 1.5 and state.idle_rungs == []
    got, drawn = [], []
    after = await web.turn(
        "a" * 24, 1, 0, "", got.append, kind="continue", on_draw=lambda ops, anchor: drawn.append((ops, anchor))
    )
    # The drawing comes with its anchor: the words of the reply before it (bot/pacer.py times it to the voice).
    assert "".join(got) == fake_web.reply and drawn == [(fake_web.draw_ops, {"words": 3})]
    assert after.seq == 0 and fake_web.calls[-1][2] == {"epoch": 1, "seq": 0, "text": "", "kind": "continue"}
    # An interview's state has no self-drive.
    fake_web.kind = "interview"
    fake_web.self_drive = None
    assert (await web.attach("a" * 24, "good-token", "task-1")).self_drive is None
