from __future__ import annotations

import asyncio

import httpx
import pytest
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
from bot.conductor import PEN_TEXT, PauseFrame, PenMarkFrame
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


async def test_a_cut_in_while_the_voice_is_still_saying_a_finished_reply_reports_what_was_heard(web, fake_web):
    # The reply's text is all in; the voice is still saying it when the candidate cuts in, then speaks.
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "Each tweet has an author row,",
        filler_after_secs=5,
        playing=lambda: True,
    )
    # Pipecat may raise the interruption more than once for the same speech: the web is told once.
    frames = [InterruptionFrame(), InterruptionFrame(), LLMContextFrame(context=_context("Wait, what is a handle?"))]
    await _run(gw, frames, None)
    actions = [c[1] for c in fake_web.calls if c[1] in ("played", "turns")]
    # What was heard reaches the web before the learner's turn, so the lesson knows the move was cut.
    assert actions == ["played", "turns"]
    played = [c for c in fake_web.calls if c[1] == "played"]
    assert played[0][2] == {"epoch": 1, "spoken": "Each tweet has an author row,"}


async def test_speech_after_the_reply_has_played_is_not_a_cut_in(web, fake_web):
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "Each tweet has an author row,",
        filler_after_secs=5,
        playing=lambda: False,
    )
    await _run(gw, [InterruptionFrame(), LLMContextFrame(context=_context("What is a handle?"))], None)
    assert not [c for c in fake_web.calls if c[1] == "played"]


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
    """A coach lesson (docs/coach-mode.md): the pipeline asks for the next move with no words
    from the learner; the sequence stands, no filler is spoken, and the drawing reaches the board callback."""
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.reply = "Next, the login service checks the password hash."
    fake_web.draw_ops = [
        {"op": "box", "label": "Login service"},
        {"op": "note", "text": "bcrypt", "near": "Login service"},
    ]
    drawn, states = [], []

    async def on_draw(ops, pace):
        drawn.append(ops)
        assert pace is None  # not paced: drawn at once

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


async def test_a_lessons_drawing_is_paced_the_words_before_it_then_each_label_between_its_pen_marks(web, fake_web):
    """bot/conductor.py: the reply's speech is split at the drawing, each operation's label is its own segment
    between its marks, and the board gets the drawing at once with the reference the cues name."""
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.reply = "Every element gets four rectangles."
    fake_web.draw_ops = [
        {"op": "region", "label": "border box", "at": {"x": 0, "y": 0}, "size": {"w": 10, "h": 10}},
        {"op": "arrow", "from": "a", "to": "b"},
    ]
    drawn = []

    async def on_draw(ops, pace):
        drawn.append((ops, pace))

    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=0,
        on_draw=on_draw,
        pace_drawings=True,
    )

    class Continue(FrameProcessor):
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
    down = [f for f in down if not isinstance(f, LLMServiceMetadataFrame)]
    ((ops, pace),) = drawn
    assert ops == fake_web.draw_ops and pace and pace.endswith(".1")
    shape = [
        (type(f).__name__, getattr(f, "phase", None) or getattr(f, "text", None))
        for f in down
        if not isinstance(f, LLMTextFrame)
    ]
    assert shape == [
        ("LLMFullResponseStartFrame", None),
        ("SegmentEndFrame", None),
        ("PenMarkFrame", "before"),
        ("TTSSpeakFrame", "border box."),
        ("PenMarkFrame", "after"),
        ("PenMarkFrame", "before"),  # the arrow has no label: a pause while it is drawn
        ("PenMarkFrame", "after"),
        ("SegmentStartFrame", None),
        ("LLMFullResponseEndFrame", None),
    ]
    speak = next(f for f in down if isinstance(f, TTSSpeakFrame))
    assert speak.text_type == PEN_TEXT and speak.append_to_context is False
    marks = [f for f in down if isinstance(f, PenMarkFrame)]
    assert {m.ref for m in marks} == {pace} and [m.item.index for m in marks] == [0, 0, 1, 1]


async def test_the_board_a_lesson_opens_with_goes_on_at_once_not_paced(web, fake_web):
    """The board drawn in earlier lessons is no part of the reply's words: no pen marks, and the room puts it on
    at once."""
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.reply = "Now the store."
    fake_web.draw_prelude = True
    fake_web.draw_ops = [{"op": "region", "label": "Mock-up", "at": {"x": 0, "y": 0}, "size": {"w": 10, "h": 10}}]
    drawn = []

    async def on_draw(ops, pace, instant=False):
        drawn.append((pace, instant))

    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=0,
        on_draw=on_draw,
        pace_drawings=True,
    )

    class Continue(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMContextFrame):
                await gw.continue_lesson()
                await gw._turn_task
                return
            await self.push_frame(frame, direction)

    down, _ = await run_test(
        Pipeline([Continue(), gw]), frames_to_send=[LLMContextFrame(context=_context("x"))], expected_down_frames=None
    )
    assert drawn == [(None, True)]
    assert not [f for f in down if isinstance(f, PenMarkFrame)]


async def test_a_lessons_reply_pauses_after_each_sentence(web, fake_web):
    """Each sentence is a segment of its own with a pause after it, wherever the stream splits it: longer after a
    question, a beat after a short setup ending in a colon, none after a long clause's colon."""
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.reply_chunks = ["First idea.", " Second", " idea. Why?", " Picture this: a list. The cursor from the last response: c1. Third, 2.5 s."]
    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=0,
        on_draw=_noop2,
        pace_drawings=True,
    )

    class Continue(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMContextFrame):
                await gw.continue_lesson()
                await gw._turn_task
                return
            await self.push_frame(frame, direction)

    down, _ = await run_test(
        Pipeline([Continue(), gw]), frames_to_send=[LLMContextFrame(context=_context("x"))], expected_down_frames=None
    )
    shape = [
        f.text if isinstance(f, LLMTextFrame) else f"pause {f.ms}" if isinstance(f, PauseFrame) else type(f).__name__
        for f in down
        if not isinstance(f, LLMServiceMetadataFrame)
    ]
    def pause(ms: int) -> list[str]:
        return ["SegmentEndFrame", f"pause {ms}", "SegmentStartFrame"]

    assert shape == [
        "LLMFullResponseStartFrame",
        "First idea.",
        *pause(800),
        "Second",
        " idea.",
        *pause(800),
        "Why?",
        *pause(1200),
        "Picture this:",
        *pause(450),
        "a list.",
        *pause(800),
        "The cursor from the last response:",
        " c1.",
        *pause(800),
        "Third, 2.5 s.",
        "LLMFullResponseEndFrame",
    ]


async def _noop2(*_):
    pass


@pytest.mark.parametrize(("after", "said"), [([" ", "."], []), ([" .", " Then", " the list."], ["Then", " the list."])])
async def test_what_follows_a_drawing_is_said_only_when_it_has_a_word(web, fake_web, after, said):
    """A segment of only a space or a sentence's "." gets no voice (the speech service fails an empty context)."""
    fake_web.kind = "coach"
    fake_web.self_drive = 1.5
    fake_web.reply = "Every element gets a box"
    fake_web.after_draw = after
    fake_web.draw_ops = [{"op": "box", "label": "box", "at": {"x": 0, "y": 0}}]

    async def on_draw(ops, pace):
        pass

    gw = GatewayLLMService(
        web=web,
        sid=SID,
        state=_state(fake_web),
        on_state=_noop,
        on_stale=_noop,
        spoken_text=lambda: "",
        filler_after_secs=0,
        on_draw=on_draw,
        pace_drawings=True,
    )

    class Continue(FrameProcessor):
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
    names = [type(f).__name__ for f in down]
    start = names.index("SegmentStartFrame")
    assert [f.text for f in down[start:] if isinstance(f, LLMTextFrame)] == said
