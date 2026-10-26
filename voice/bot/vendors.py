"""The speech vendors a pipeline is built with (README "Settings"): who transcribes and who speaks.

Deepgram and Cartesia serve from the US, Sarvam and Smallest from India; from Mumbai (where the service
runs) or Bengaluru that is about 0.2 s less on each leg of an exchange. Each vendor's service comes from
Pipecat; this module only picks and configures them from the settings, so they can be A/B'd on the
`voice latency` line with an environment change.
"""

from __future__ import annotations

import asyncio
import re
import time

from loguru import logger
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.text.base_text_filter import BaseTextFilter

from app.config import Settings
from bot.first_clause import install_first_clause

STT_VENDORS = ("deepgram", "flux", "sarvam", "smallest")
TTS_VENDORS = ("cartesia", "sarvam", "smallest")


def build_stt(settings: Settings, language: Language) -> STTService:
    """The transcriber for `settings.stt_vendor`, streaming interim results; the pipeline's own VAD and
    smart-turn decide the turns."""
    vendor = settings.stt_vendor
    if vendor == "deepgram":
        from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings

        return DeepgramSTTService(
            api_key=settings.deepgram_api_key,
            settings=DeepgramSTTSettings(
                model=settings.deepgram_model, language=language, smart_format=True, interim_results=True
            ),
        )
    if vendor == "flux":
        from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService

        # Flux ends the turn itself (run.py gives the aggregator external strategies for it) and, with
        # the speculative start on, predicts the end first: that prediction (EagerTranscriptionFrame)
        # is what bot/speculate.py posts. Pipecat's own eager strategy is not used, so the prediction
        # never runs an inference here.
        thresholds = {
            k: v
            for k, v in (
                ("eot_threshold", settings.flux_eot),
                ("eager_eot_threshold", settings.flux_eager_eot if settings.speculate else None),
            )
            if v is not None
        }
        return DeepgramFluxSTTService(
            api_key=settings.deepgram_api_key,
            enable_eager_end_of_turn=settings.speculate,
            settings=DeepgramFluxSTTService.Settings(model=settings.flux_model, language=language, **thresholds),
        )
    if vendor == "sarvam":
        from pipecat.services.sarvam.stt import SarvamRealtimeSTTService

        # `manual` endpointing: the pipeline, not Sarvam, decides where a turn ends; the service flushes
        # its final on the VAD's stop. `fast` streams interim words soonest.
        return SarvamRealtimeSTTService(
            api_key=settings.sarvam_api_key,
            endpointing="manual",
            settings=SarvamRealtimeSTTService.Settings(
                model=settings.sarvam_stt_model, language=Language.EN_IN, stream_type="fast"
            ),
        )
    if vendor == "smallest":
        from pipecat.services.smallest.stt import SmallestSTTService

        return SmallestSTTService(
            api_key=settings.smallest_api_key,
            settings=SmallestSTTService.Settings(model=settings.smallest_stt_model, language=Language.EN),
        )
    raise ValueError(f"VOICE_STT={vendor} is not one of {', '.join(STT_VENDORS)}")


class SayAsLetters(BaseTextFilter):
    """Words the voice must spell rather than read: "id" is "I D", not the word "id" ("aayed"). Only what is
    synthesized changes; the reply's words, the transcript and the board keep "id"."""

    _WORD = re.compile(r"\b[Ii][Dd](s?)\b")  # id, ids, Id
    _TAIL = re.compile(r"(?<=[a-z])Id(s?)\b")  # authorId, tweetIds

    async def filter(self, text: str) -> str:
        return self._WORD.sub(r"ID\1", self._TAIL.sub(r" ID\1", text))


def build_tts(settings: Settings) -> TTSService:
    """The interviewer's voice for `settings.tts_vendor`: an Indian-accented English female voice at a
    measured pace on every vendor, starting on the reply's first clause when `settings.first_clause`."""
    tts = _build_tts(settings)
    if settings.first_clause:
        install_first_clause(tts)
    return tts


def _build_tts(settings: Settings) -> TTSService:
    vendor = settings.tts_vendor
    if vendor == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig

        return CartesiaTTSService(
            api_key=settings.cartesia_api_key,
            voice_id=settings.cartesia_voice_id,
            model=settings.cartesia_model,
            text_filters=[SayAsLetters()],
            params=CartesiaTTSService.InputParams(
                language=Language.EN, generation_config=GenerationConfig(speed=settings.cartesia_speed)
            ),
        )
    if vendor == "sarvam":
        from pipecat.services.sarvam.tts import SarvamTTSService

        return SarvamTTSService(
            api_key=settings.sarvam_api_key,
            text_filters=[SayAsLetters()],
            settings=SarvamTTSService.Settings(
                model=settings.sarvam_tts_model,
                voice=settings.sarvam_speaker,
                language=Language.EN_IN,
                pace=settings.sarvam_pace,
            ),
        )
    if vendor == "smallest":
        smallest = _smallest_tts()
        return smallest(
            api_key=settings.smallest_api_key,
            text_filters=[SayAsLetters()],
            settings=smallest.Settings(
                model=settings.smallest_tts_model,
                voice=settings.smallest_voice,
                language=Language.EN,
                speed=settings.smallest_speed,
            ),
        )
    raise ValueError(f"VOICE_TTS={vendor} is not one of {', '.join(TTS_VENDORS)}")


# A flushed Smallest context that has been quiet this long has no more audio coming.
SMALLEST_FLUSHED_QUIET_SECS = 0.8


def _smallest_tts():
    """Smallest's voice, ending a context soon after its audio stops once nothing more will be said in it.

    Smallest's live socket never says a request is done, so Pipecat ends a context only after its stop timeout
    (3 s) of quiet, and holds the next text until then. At the end of a reply nobody hears that; a lesson's
    reply spoken in segments around its drawings (bot/conductor.py) would pause 3 s at every label. A context
    that has been flushed gets no more text, and its audio streams in chunks a few tens of ms apart, so once it
    has sounded, a short quiet ends it.
    """
    from pipecat.frames.frames import TTSAudioRawFrame
    from pipecat.services.smallest.tts import SmallestTTSService

    class SmallestSegmentsTTSService(SmallestTTSService):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._flushed: set[str] = set()
            self._sounding: set[str] = set()

        async def flush_audio(self, context_id: str | None = None):
            await super().flush_audio(context_id)
            flushed = context_id or self.get_active_audio_context_id()
            if flushed:
                self._flushed.add(flushed)

        async def _next_audio_context_item(self, context_id: str):
            if context_id in self._flushed and context_id in self._sounding:
                try:
                    item = await self._audio_context_manager.get(context_id, timeout=SMALLEST_FLUSHED_QUIET_SECS)
                except TimeoutError:
                    item = None
            else:
                item = await super()._next_audio_context_item(context_id)
            if isinstance(item, TTSAudioRawFrame):
                self._sounding.add(context_id)
            if item is None:
                self._flushed.discard(context_id)
                self._sounding.discard(context_id)
            return item

    return SmallestSegmentsTTSService


async def voice_ready(tts: TTSService, timeout_secs: float = 6.0) -> bool:
    """Whether the voice can speak, opening its socket again if the one opened at the start failed (a
    handshake that timed out): a lesson's first move sent into a closed socket is lost, and the room waits on it.
    A voice without a socket is always ready."""
    if not hasattr(tts, "_websocket") or not hasattr(tts, "_connect"):
        return True

    def open_() -> bool:
        ws = getattr(tts, "_websocket", None)
        return ws is not None and getattr(getattr(ws, "state", None), "name", "") == "OPEN"

    deadline = time.monotonic() + timeout_secs
    # The connect started with the pipeline may still be under way: give it a moment first.
    while not open_() and time.monotonic() < deadline - timeout_secs / 2:  # noqa: ASYNC110 - a socket state, no event
        await asyncio.sleep(0.1)
    if not open_():
        logger.warning("voice socket not open; connecting again")
        try:
            await asyncio.wait_for(tts._connect(), timeout=max(0.5, deadline - time.monotonic()))
        except Exception as err:  # noqa: BLE001 - reported, and the lesson goes on
            logger.warning("voice socket connect failed: {}", err)
    return open_()
