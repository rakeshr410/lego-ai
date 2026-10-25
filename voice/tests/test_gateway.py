from __future__ import annotations

import asyncio

import httpx
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMServiceMetadataFrame,
    LLMTextFrame,
    TTSSpeakFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.tests.utils import run_test

from app.web_client import State
from bot import speech
from bot.llm_gateway import GatewayLLMService

SID = "a" * 24


def _state(fake_web) -> State:
    return State.parse(fake_web.state())


def _context(text: str) -> LLMContext:
    ctx = LLMContext()
    ctx.add_message({"role": "user", "content": text})
    return ctx


async def _noop(_):
    pass


async def _run(gw, frames, expected):
    """run_test without the service's own metadata frame, which every LLM service announces itself with."""
    down, _ = await run_test(gw, frames_to_send=frames, expected_down_frames=None)
    down = [f for f in down if not isinstance(f, LLMServiceMetadataFrame)]
    if expected is not None:
        assert [type(f) for f in down] == expected, [type(f).__name__ for f in down]
    return down


async def test_streams_the_reply_and_keeps_the_state(web, fake_web):
    states = []

    async def on_state(s):
        states.append(s)

    async def on_stale(err):
        raise AssertionError(err)

    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=on_state,
        on_stale=on_stale,
        spoken_text=lambda: "",
        filler_after_secs=5,
    )
    down = await _run(
        gw,
        [LLMContextFrame(context=_context("Mobile web first."))],
        [LLMFullResponseStartFrame, LLMTextFrame, LLMTextFrame, LLMFullResponseEndFrame],
    )
    assert "".join(f.text for f in down if isinstance(f, LLMTextFrame)) == fake_web.reply
    assert gw.state.seq == 1 and states[-1].seq == 1
    assert fake_web.calls[-1][1] == "turns" and fake_web.calls[-1][2] == {
        "epoch": 1,
        "seq": 1,
        "text": "Mobile web first.",
    }
    assert gw.fillers == 0


async def test_speaks_a_filler_when_the_first_words_are_slow(web, fake_web):
    original = fake_web.handler

    async def slow(request):
        await asyncio.sleep(0.2)
        return original(request)

    web._client._transport = httpx.MockTransport(slow)
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=0.05,
    )
    down = await _run(
        gw,
        [LLMContextFrame(context=_context("Hello."))],
        [LLMFullResponseStartFrame, TTSSpeakFrame, LLMTextFrame, LLMTextFrame, LLMFullResponseEndFrame],
    )
    filler = next(f for f in down if isinstance(f, TTSSpeakFrame))
    assert filler.text in speech.FILLERS and filler.append_to_context is False
    assert gw.fillers == 1


async def test_a_stale_epoch_stops_the_pipeline_and_a_closed_session_ends_it(web, fake_web):
    stale = []
    states = []

    async def on_state(s):
        states.append(s)

    async def on_stale(err):
        stale.append(err.code)

    fake_web.epoch = 2
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=on_state,
        on_stale=on_stale,
        spoken_text=lambda: "",
        filler_after_secs=5,
    )
    gw.state.epoch = 1
    await _run(gw, [LLMContextFrame(context=_context("Hello?"))], [LLMFullResponseStartFrame, LLMFullResponseEndFrame])
    assert stale == ["stale_epoch"] and states == []

    fake_web.epoch = 1
    fake_web.refuse["turns"] = (409, "turns")
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=on_state,
        on_stale=on_stale,
        spoken_text=lambda: "",
        filler_after_secs=5,
    )
    await _run(
        gw, [LLMContextFrame(context=_context("One more thing."))], [LLMFullResponseStartFrame, LLMFullResponseEndFrame]
    )
    assert states[-1].closed == "turns"
    # Closed: nothing more goes to the web.
    before = len(fake_web.calls)
    await _run(gw, [LLMContextFrame(context=_context("Hello?"))], [])
    assert len(fake_web.calls) == before


async def test_an_interruption_drops_the_stream_and_reports_what_played(web, fake_web):
    original = fake_web.handler
    fake_web.reply_chunks = ["Who are ", "the users, ", "and on which devices?"]
    reached = []

    async def slow(request):
        # The candidate cuts in while the reply is on its way: the call is dropped before it completes.
        await gw.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.02)
        reached.append(request.url.path)
        return original(request)

    web._client._transport = httpx.MockTransport(slow)
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "Who are the users,",
        filler_after_secs=5,
    )
    down = await _run(gw, [LLMContextFrame(context=_context("Mobile web first."))], None)
    assert not any(isinstance(f, LLMTextFrame) for f in down)
    # The turn's call never finished (the web saves what streamed); the words heard are reported.
    assert reached == [f"/api/internal/interview/{SID}/played"]
    played = [c for c in fake_web.calls if c[1] == "played"]
    assert played and played[0][2] == {"epoch": 1, "spoken": "Who are the users,"}
    # The next turn follows as seq 2: the web kept the cut one.
    assert gw.state.seq == 1 and gw.turns == 1 and gw.failures == 0
    assert not gw.busy


async def test_a_turn_refused_as_busy_is_sent_again(web, fake_web):
    original = fake_web.handler
    busy = {"left": 2}

    def handler(request):
        if request.url.path.endswith("/turns") and busy["left"]:
            busy["left"] -= 1
            return httpx.Response(409, json={"error": "answering", "code": "busy", "status": 409, "retryAfter": None})
        return original(request)

    web._client._transport = httpx.MockTransport(handler)
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=5,
    )
    down = await _run(
        gw,
        [LLMContextFrame(context=_context("Mobile web first."))],
        [LLMFullResponseStartFrame, LLMTextFrame, LLMTextFrame, LLMFullResponseEndFrame],
    )
    assert "".join(f.text for f in down if isinstance(f, LLMTextFrame)) == fake_web.reply
    assert gw.state.seq == 1 and gw.failures == 0
    assert len([c for c in fake_web.calls if c[1] == "turns"]) == 1  # the fake counts only the call it answered


async def test_a_web_outage_is_said_once_and_the_line_stays_open(web):
    def down(request):
        raise httpx.ConnectError("down")

    web._client._transport = httpx.MockTransport(down)
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=State.parse({"epoch": 1}),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=5,
    )
    frames = await _run(
        gw,
        [LLMContextFrame(context=_context("Hello."))],
        [LLMFullResponseStartFrame, TTSSpeakFrame, LLMFullResponseEndFrame],
    )
    assert frames[1].text == speech.MISSED and gw.failures == 1


async def test_a_continue_asks_for_the_coachs_next_move_and_forwards_its_drawing(web, fake_web):
    """A coach lesson (docs/interview/coach-mode.md): the pipeline asks for the next move with no words
    from the learner; the sequence stands, no filler is spoken, and the drawing reaches the board callback."""
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.reply = "Next, the login service checks the password hash."
    fake_web.draw_ops = [
        {"op": "box", "label": "Login service"},
        {"op": "note", "text": "bcrypt", "near": "Login service"},
    ]
    drawn, states = [], []

    async def on_draw(ops, anchor):
        drawn.append(ops)
        assert anchor == {"words": 3}

    async def on_state(s):
        states.append(s)

    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=on_state,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=0.01,
        on_draw=on_draw,
    )

    class Continue(FrameProcessor):
        """Asks for the move once the pipeline runs (as the idle clock's self-drive would)."""

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMContextFrame):
                await gw.continue_lesson()
                await gw._turn_task
                return
            await self.push_frame(frame, direction)

    down, _ = await run_test(
        Pipeline([Continue(), gw]),
        frames_to_send=[LLMContextFrame(context=_context("ignored"))],
        expected_down_frames=None,
    )
    texts = [f.text for f in down if isinstance(f, LLMTextFrame)]
    assert "".join(texts) == fake_web.reply
    assert not any(isinstance(f, TTSSpeakFrame) for f in down)  # no filler for a move nobody asked for
    turns = [c for c in fake_web.calls if c[1] == "turns"]
    assert turns == [(SID, "turns", {"epoch": 1, "seq": 0, "text": "", "kind": "continue"})]
    assert drawn == [fake_web.draw_ops]
    assert gw.continues == 1 and gw.turns == 0 and gw.state.seq == 0
    assert states[-1].kind == "coach" and states[-1].self_drive == 1.5
