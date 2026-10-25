"""The speech vendors a pipeline is built with (README "Settings"): who transcribes and who speaks.

Deepgram and Cartesia serve from the US, Sarvam and Smallest from India; from Mumbai (where the service
runs) or Bengaluru that is about 0.2 s less on each leg of an exchange. Each vendor's service comes from
Pipecat; this module only picks and configures them from the settings, so they can be A/B'd on the
`voice latency` line with an environment change.
"""

from __future__ import annotations

from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language

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
            params=CartesiaTTSService.InputParams(
                language=Language.EN, generation_config=GenerationConfig(speed=settings.cartesia_speed)
            ),
        )
    if vendor == "sarvam":
        from pipecat.services.sarvam.tts import SarvamTTSService

        return SarvamTTSService(
            api_key=settings.sarvam_api_key,
            settings=SarvamTTSService.Settings(
                model=settings.sarvam_tts_model,
                voice=settings.sarvam_speaker,
                language=Language.EN_IN,
                pace=settings.sarvam_pace,
            ),
        )
    if vendor == "smallest":
        from pipecat.services.smallest.tts import SmallestTTSService

        return SmallestTTSService(
            api_key=settings.smallest_api_key,
            settings=SmallestTTSService.Settings(
                model=settings.smallest_tts_model,
                voice=settings.smallest_voice,
                language=Language.EN,
                speed=settings.smallest_speed,
            ),
        )
    raise ValueError(f"VOICE_TTS={vendor} is not one of {', '.join(TTS_VENDORS)}")
