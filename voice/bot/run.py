"""One voice session's pipeline (design section 6): Daily in, the transcriber, the turn shaper, the user
aggregator (Silero VAD and smart-turn end-of-turn), the gateway interviewer, the voice, the conductor (a
lesson's pauses and pen cues around its labels), the output, the assistant aggregator, the idle gate; the
vendors are bot/vendors.py's. The web tier is attached first; the pipeline stops when the session closes, the
candidate leaves, the web refuses its epoch, or the task is asked to stop (a deploy: the session is parked for a
rejoin).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import EndFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIProcessor
from pipecat.transcriptions.language import Language
from pipecat.transports.daily.transport import DailyParams, DailyTransport
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies, UserTurnStrategies

from app.config import Settings
from app.web_client import State, WebClient, WebError
from bot import speech
from bot.conductor import Conductor
from bot.idle import IdleGate, IdleTimer
from bot.latency import LatencyObserver
from bot.llm_gateway import GatewayLLMService
from bot.observers import UsageObserver
from bot.speculate import Speculator
from bot.sync import Heartbeat
from bot.turn_shaper import TurnShaper
from bot.vendors import build_stt, build_tts, voice_ready


@dataclass
class SessionSpec:
    """What the web sends to start a pipeline (POST /sessions)."""

    sid: str
    attach: str
    room_url: str
    room_token: str
    language: str = "en-IN"
    audio_opt_in: bool = False
    planned_minutes: int = 45
    # A mock interview, or a coach lesson (docs/coach-mode.md): the bot's name and closing lines.
    kind: str = "interview"
    # The pause that ends the speaker's turn, when the web wants one other than the service's default.
    turn_stop_secs: float | None = None

    @staticmethod
    def parse(body: dict[str, Any]) -> SessionSpec:
        room = body.get("room") or {}
        stop = body.get("turnStopSecs")
        return SessionSpec(
            sid=str(body["sid"]),
            attach=str(body["attach"]),
            room_url=str(room["url"]),
            room_token=str(room["token"]),
            language=str(body.get("language") or "en-IN"),
            audio_opt_in=bool(body.get("audioOptIn")),
            planned_minutes=int(body.get("plannedMinutes") or 45),
            kind="coach" if body.get("kind") == "coach" else "interview",
            turn_stop_secs=min(5.0, max(0.8, float(stop))) if stop is not None else None,
        )


@dataclass
class SessionRun:
    """A running pipeline and how it ended."""

    spec: SessionSpec
    task_id: str
    state: State | None = None
    ended: str | None = None
    detached: bool = False
    usage: UsageObserver | None = None
    gateway: GatewayLLMService | None = None
    conductor: Conductor | None = None
    _task: PipelineTask | None = field(default=None, repr=False)
    _stop_requested: str | None = field(default=None, repr=False)

    async def stop(self, reason: str = "transport") -> None:
        """Asks the pipeline to stop; `reason` is what the web is told on detach (transport: parked)."""
        self._stop_requested = reason
        if self._task:
            if reason == "transport":
                await self._task.queue_frame(TTSSpeakFrame(speech.RECONNECT_BRIDGE, append_to_context=False))
            await self._task.queue_frame(EndFrame())


ATTACH_BUSY_TRIES = 20
ATTACH_BUSY_WAIT_SECS = 0.5
LEAVE_GRACE_SECS = 10.0
# The longest wait a room may ask a lesson for (the web's own are 1.5 s and 45 s).
MAX_SELF_DRIVE_SECS = 120.0


class RejoinWindow:
    """After the candidate leaves the room, the pipeline waits a while for them to come back (a reload
    rejoins with a fresh token within seconds) before it ends and parks the session."""

    def __init__(self, grace_secs: float, on_gone: Callable[[], Awaitable[None]]):
        self._grace = grace_secs
        self._on_gone = on_gone
        self._timer: asyncio.Task[None] | None = None

    def left(self) -> None:
        self.cancel()
        self._timer = asyncio.create_task(self._wait())

    def joined(self) -> bool:
        """The candidate is in the room; True when they came back inside the window."""
        back = self._timer is not None
        self.cancel()
        return back

    def cancel(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None

    async def _wait(self) -> None:
        await asyncio.sleep(self._grace)
        self._timer = None
        await self._on_gone()


async def attach_with_retry(web: WebClient, spec: SessionSpec, task_id: str) -> State:
    """Attaches, waiting out a `busy` session: the web still holds the session's lock while it starts
    this pipeline (join), or a reply is in flight; both clear within seconds. Any other refusal is final."""
    for attempt in range(1, ATTACH_BUSY_TRIES + 1):
        try:
            return await web.attach(spec.sid, spec.attach, task_id)
        except WebError as err:
            if err.code != "busy" or attempt == ATTACH_BUSY_TRIES:
                raise
            await asyncio.sleep(ATTACH_BUSY_WAIT_SECS)
    raise AssertionError("unreachable")


async def run_session(
    spec: SessionSpec, settings: Settings, web: WebClient, task_id: str, run: SessionRun | None = None
) -> SessionRun:
    """Attaches to the session and runs its pipeline until it ends; returns how it went."""
    run = run or SessionRun(spec=spec, task_id=task_id)
    try:
        state = await attach_with_retry(web, spec, task_id)
    except WebError as err:
        run.ended = f"attach_refused:{err.code}"
        logger.warning("voice attach {} refused: {}", spec.sid, err)
        return run
    run.state = state
    epoch = state.epoch
    logger.info("voice attached {} epoch={} resumed={} stage={}", spec.sid, epoch, state.resumed, state.stage_index)

    language = Language.EN_IN if spec.language.lower() == "en-in" else Language.EN
    transport = DailyTransport(
        spec.room_url,
        spec.room_token,
        "Coach" if spec.kind == "coach" else "Interviewer",
        DailyParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    stt = build_stt(settings, language)
    tts = build_tts(settings)
    rtvi = RTVIProcessor(transport=transport)
    audio_in = transport.input()
    audio_out = transport.output()
    usage = UsageObserver(audio_in=audio_in, audio_out=audio_out, stt=stt, tts=tts)
    shaper = TurnShaper(echoes=usage.memory.echoes)
    run.usage = usage

    ending = asyncio.Event()

    async def finish(reason: str, say: str | None = None) -> None:
        """Ends the pipeline once: the closing line, then the end frame."""
        if ending.is_set():
            return
        ending.set()
        run.ended = reason
        if say and task:
            await task.queue_frame(TTSSpeakFrame(say, append_to_context=False))
        if task:
            await task.queue_frame(EndFrame())

    async def on_state(new: State) -> None:
        run.state = new
        await rtvi.send_server_message(
            {"kind": "state", "stageIndex": new.stage_index, "closed": new.closed, "exchangesLeft": new.exchanges_left}
        )
        # A lesson's self-drive follows the coach's last move (waiting for an answer, or not).
        idle.timer.self_drive = new.self_drive
        if new.closed:
            await finish(f"closed:{new.closed}", speech.closing(new.closed, spec.kind))

    async def on_stale(err: WebError) -> None:
        run.detached = True  # the web already moved on; nothing to detach
        await finish(f"stale:{err.code}")

    async def on_closed(reason: str) -> None:
        if run.state:
            run.state.closed = reason
        await finish(f"closed:{reason}", speech.closing(reason, spec.kind))

    # The drawings go to the room's board over the call as the web sends them. In a lesson each carries a
    # reference (pace), and the pen waits for the voice's cues to draw it: the conductor, after the voice, says
    # each label as the pen writes it, with a pause before and after (bot/conductor.py).
    async def on_draw(ops: list[Any], pace: str | None, instant: bool = False) -> None:
        extra = {"pace": pace} if pace else {"instant": True} if instant else {}
        await rtvi.send_server_message({"kind": "draw", "ops": ops, **extra})

    conductor = Conductor()
    run.conductor = conductor

    gateway = GatewayLLMService(
        web=web,
        sid=spec.sid,
        state=state,
        on_state=on_state,
        on_stale=on_stale,
        spoken_text=usage.spoken_text,
        playing=lambda: usage.playing,
        filler_after_secs=settings.filler_after_secs,
        on_draw=on_draw,
        pace_drawings=spec.kind == "coach",
    )
    run.gateway = gateway

    async def on_rung(rung: int) -> None:
        try:
            new = await web.idle(spec.sid, epoch, rung)
        except WebError as err:
            if err.stale:
                await on_stale(err)
            return
        if new.say and task:
            await task.queue_frame(TTSSpeakFrame(new.say, append_to_context=False))
        run.state = new
        idle.timer.self_drive = new.self_drive

    async def on_continue() -> None:
        # A reply on its way (the learner's turn is being answered): it speaks, and its end arms the clock again.
        if gateway.busy:
            return
        await gateway.continue_lesson()

    idle = IdleGate(timer=IdleTimer(state.idle_rungs, on_rung, on_continue=on_continue))
    idle.timer.self_drive = state.self_drive

    # The learner turned the lesson's questions on or off in the room: the web answered with the new wait, and
    # the room passes it on. A clock already running starts again on it (no more waiting for an answer).
    @rtvi.event_handler("on_client_message")
    async def on_client_message(_rtvi, msg) -> None:
        if spec.kind != "coach" or msg.type != "pace" or not isinstance(msg.data, dict):
            return
        wait = msg.data.get("selfDrive")
        if wait is not None and (not isinstance(wait, int | float) or not 0 <= wait <= MAX_SELF_DRIVE_SECS):
            return
        idle.timer.self_drive = float(wait) if wait is not None else None
        if idle.timer.armed:
            idle.timer.arm()

    context = LLMContext()
    # Who ends the turn: Flux does it itself (external strategies; Pipecat's eager strategy is not
    # used, so Flux's prediction only reaches the Speculator); otherwise the VAD's silence and
    # smart-turn's verdict. The VAD stays on either way: the latency line times from its stop.
    eager = settings.stt_vendor == "flux"
    strategies = (
        ExternalUserTurnStrategies(enable_interruptions=True)
        if eager
        else UserTurnStrategies(
            stop=[
                TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(
                        params=SmartTurnParams(stop_secs=spec.turn_stop_secs or settings.turn_stop_secs)
                    )
                )
            ]
        )
    )
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)), user_turn_strategies=strategies
        ),
    )

    pipeline = Pipeline(
        [
            audio_in,
            rtvi,
            stt,
            shaper,
            aggregators.user(),
            gateway,
            tts,
            conductor,
            audio_out,
            aggregators.assistant(),
            idle,
        ]
    )
    observers = [RTVIObserver(rtvi), usage, LatencyObserver(spec.sid)]
    if settings.speculate:
        observers.append(
            Speculator(
                web=web,
                sid=spec.sid,
                epoch=lambda: gateway.state.epoch,
                busy=lambda: gateway.busy,
                transcripts=shaper,
                eager=eager,
            )
        )
    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=observers,
        idle_timeout_secs=settings.idle_timeout_secs,
        cancel_on_idle_timeout=False,
    )
    run._task = task

    heartbeat = Heartbeat(
        web=web,
        sid=spec.sid,
        epoch=epoch,
        usage=usage,
        period_secs=settings.heartbeat_secs,
        on_closed=on_closed,
        on_stale=on_stale,
        stt=settings.stt_vendor,
        tts=settings.tts_vendor,
    )

    rejoin = RejoinWindow(LEAVE_GRACE_SECS, lambda: finish("left"))
    opened = False

    @transport.event_handler("on_participant_joined")
    async def on_joined(transport, participant):
        nonlocal opened
        back = rejoin.joined()
        logger.info("voice candidate {} {}", "rejoined" if back else "joined", spec.sid)
        await rtvi.set_bot_ready()
        if not opened:
            opened = True
            if state.say:
                await task.queue_frame(TTSSpeakFrame(state.say, append_to_context=False))
            elif state.self_drive is not None:
                # A lesson that has not opened: nothing to repeat, the coach's first move is fetched, once the
                # voice can speak it (a socket that failed to open at the start is opened again first).
                if not await voice_ready(tts):
                    logger.warning("voice {} starting without a ready voice", spec.sid)
                await gateway.continue_lesson()

    @transport.event_handler("on_participant_left")
    async def on_left(transport, participant, reason):
        logger.info("voice candidate left {} ({}); waiting {} s for a rejoin", spec.sid, reason, LEAVE_GRACE_SECS)
        rejoin.left()

    @transport.event_handler("on_error")
    async def on_error(transport, error):
        logger.error("voice transport {} error: {}", spec.sid, error)
        await finish("transport_error")

    @task.event_handler("on_idle_timeout")
    async def on_idle_timeout(task):
        logger.info("voice pipeline {} idle for {} s", spec.sid, settings.idle_timeout_secs)
        await finish("idle")

    heartbeat.start()
    runner = PipelineRunner(handle_sigint=False, handle_sigterm=False)
    try:
        await runner.run(task)
    finally:
        rejoin.cancel()
        heartbeat.stop()
        if run._stop_requested and not run.ended:
            run.ended = f"stopped:{run._stop_requested}"
        if not run.detached:
            reason = _detach_reason(run)
            try:
                await web.detach(spec.sid, epoch, reason)
            except Exception as err:  # noqa: BLE001
                logger.warning("voice detach {}: {}", spec.sid, err)
            run.detached = True
        logger.info(
            "voice pipeline {} ended: {} stt={:.0f}s tts={} chars turns={} continues={}",
            spec.sid,
            run.ended,
            usage.stt_seconds,
            usage.tts_chars,
            gateway.turns,
            gateway.continues,
        )
    return run


def _detach_reason(run: SessionRun) -> str:
    """What the web is told: the line dropped (parked, a rejoin continues) or the voice part is over."""
    ended = run.ended or ""
    if (
        run._stop_requested == "transport"
        or ended in ("left", "transport_error", "idle")
        or ended.startswith("stopped:")
    ):
        return "transport"
    if ended.startswith("closed:"):
        return "ended"
    if ended.startswith("stale:"):
        return "ended"
    return "error"
