"""The service's settings, from the environment (interview-voice/README.md)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name, "")
    try:
        return max(lo, min(hi, int(raw)))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, ""))
    except ValueError:
        return default


def _float_or_none(name: str) -> float | None:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return None


@dataclass(frozen=True)
class Settings:
    """Everything the service reads from the environment, once at start."""

    # The web tier: its origin on the private network and the shared bearer (both directions).
    web_url: str = field(
        default_factory=lambda: os.environ.get("INTERVIEW_WEB_URL", "http://web.internal:4321").rstrip("/")
    )
    secret: str = field(default_factory=lambda: os.environ.get("INTERVIEW_VOICE_SECRET", ""))
    # The speech vendors (bot/vendors.py): who transcribes and who speaks. Deepgram and Cartesia serve
    # from the US; Sarvam and Smallest from India, nearer the Mumbai deployment and the candidates.
    stt_vendor: str = field(default_factory=lambda: os.environ.get("VOICE_STT", "deepgram").strip().lower())
    # Deepgram Flux (VOICE_STT=flux): the transcriber decides where a turn ends (no smart-turn), and predicts
    # the end ahead of committing to it, which the speculative start acts on. The thresholds are Flux's
    # end-of-turn confidences (0 to 1): the one it commits at (unset: Deepgram's 0.7) and the one it predicts
    # at, kept low (Deepgram's default is 0.5): a prediction withdrawn costs one unused model call, one that
    # holds starts the reply that much earlier.
    flux_model: str = field(default_factory=lambda: os.environ.get("DEEPGRAM_FLUX_MODEL", "flux-general-en"))
    flux_eot: float | None = field(default_factory=lambda: _float_or_none("DEEPGRAM_FLUX_EOT"))
    flux_eager_eot: float = field(default_factory=lambda: min(0.9, max(0.1, _float("DEEPGRAM_FLUX_EAGER_EOT", 0.3))))
    tts_vendor: str = field(default_factory=lambda: os.environ.get("VOICE_TTS", "cartesia").strip().lower())
    # The vendors' keys. The Daily API key is not needed here: the web mints the bot's meeting token.
    deepgram_api_key: str = field(default_factory=lambda: os.environ.get("DEEPGRAM_API_KEY", ""))
    cartesia_api_key: str = field(default_factory=lambda: os.environ.get("CARTESIA_API_KEY", ""))
    sarvam_api_key: str = field(default_factory=lambda: os.environ.get("SARVAM_API_KEY", ""))
    smallest_api_key: str = field(default_factory=lambda: os.environ.get("SMALLEST_API_KEY", ""))
    # Sarvam: saaras realtime transcription (en-IN) and bulbul voices. The speaker is a bulbul:v3 name
    # (ritu, priya, neha, pooja, simran, kavya, ishita, shreya, roopa read as female; pick by ear).
    sarvam_stt_model: str = field(default_factory=lambda: os.environ.get("SARVAM_STT_MODEL", "saaras:v3-realtime"))
    sarvam_tts_model: str = field(default_factory=lambda: os.environ.get("SARVAM_TTS_MODEL", "bulbul:v3"))
    sarvam_speaker: str = field(default_factory=lambda: os.environ.get("SARVAM_SPEAKER", "priya"))
    sarvam_pace: float = field(default_factory=lambda: min(2.0, max(0.5, _float("SARVAM_PACE", 1.1))))
    # Smallest: pulse transcription and lightning voices (meher: Indian English, female, on lightning_v3.1_pro).
    smallest_stt_model: str = field(default_factory=lambda: os.environ.get("SMALLEST_STT_MODEL", "pulse"))
    smallest_tts_model: str = field(default_factory=lambda: os.environ.get("SMALLEST_TTS_MODEL", "lightning_v3.1_pro"))
    smallest_voice: str = field(default_factory=lambda: os.environ.get("SMALLEST_VOICE", "meher"))
    smallest_speed: float = field(default_factory=lambda: min(2.0, max(0.5, _float("SMALLEST_SPEED", 1.0))))
    # The interviewer's voice: Cartesia's "Kiara - Joyful Woman", Indian-accented English, female
    # (owner's call, 2026-10-24; "Devansh - Warm Support Agent" 1259b7e3-cb8a-43df-9446-30971a46b8b0
    # is the male counterpart), at a measured pace: speed is sonic-3's multiplier, 0.6 to 1.5.
    cartesia_voice_id: str = field(
        default_factory=lambda: os.environ.get("CARTESIA_VOICE_ID", "f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d")
    )
    cartesia_speed: float = field(default_factory=lambda: min(1.5, max(0.6, _float("CARTESIA_SPEED", 0.85))))
    cartesia_model: str = field(default_factory=lambda: os.environ.get("CARTESIA_MODEL", "sonic-3"))
    deepgram_model: str = field(default_factory=lambda: os.environ.get("DEEPGRAM_MODEL", "nova-3"))
    # Sessions one task runs at once (design section 6: 2 vCPU / 4 GB carries about four).
    max_sessions: int = field(default_factory=lambda: _int("VOICE_MAX_SESSIONS_PER_TASK", 4, 1, 32))
    port: int = field(default_factory=lambda: _int("PORT", 7860, 1, 65535))
    # The pipeline's timings (seconds).
    heartbeat_secs: float = field(default_factory=lambda: _float("VOICE_HEARTBEAT_SECS", 15.0))
    # How long a pause may run before the turn ends when smart-turn hears the candidate as not finished
    # (Pipecat's default is 3 s; the model's own "finished" verdict ends a turn sooner than this).
    turn_stop_secs: float = field(default_factory=lambda: min(5.0, max(0.8, _float("VOICE_TURN_STOP_SECS", 2.0))))
    # A scripted filler ("Right.") when the first words are late by this much; 0 (the default) never: the
    # owner would rather have the silence than a filler (2026-10-24).
    filler_after_secs: float = field(default_factory=lambda: _float("VOICE_FILLER_AFTER_SECS", 0.0))
    # The speculative start (bot/speculate.py): the web is told the words heard as soon as the VAD hears
    # silence, before smart-turn and the final transcript confirm the turn, and starts the reply on them.
    speculate: bool = field(
        default_factory=lambda: os.environ.get("VOICE_SPECULATE", "true").strip().lower() != "false"
    )
    # The voice starts on the reply's first clause (bot/first_clause.py) rather than its first sentence.
    first_clause: bool = field(
        default_factory=lambda: os.environ.get("VOICE_FIRST_CLAUSE", "true").strip().lower() != "false"
    )
    idle_timeout_secs: float = field(default_factory=lambda: _float("VOICE_IDLE_TIMEOUT_SECS", 900.0))
    # Raw audio for QA when the candidate opted in: a directory (unset: never written; kept 7 days).
    audio_dir: str = field(default_factory=lambda: os.environ.get("VOICE_AUDIO_DIR", ""))
    log_level: str = field(default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO").upper())

    def problems(self) -> list[str]:
        """What stops the service from running: a missing bearer or vendor key."""
        out = []
        if len(self.secret) < 32:
            out.append("INTERVIEW_VOICE_SECRET must be at least 32 characters")
        keys = {
            "deepgram": ("DEEPGRAM_API_KEY", self.deepgram_api_key),
            "flux": ("DEEPGRAM_API_KEY", self.deepgram_api_key),
            "cartesia": ("CARTESIA_API_KEY", self.cartesia_api_key),
            "sarvam": ("SARVAM_API_KEY", self.sarvam_api_key),
            "smallest": ("SMALLEST_API_KEY", self.smallest_api_key),
        }
        if self.stt_vendor not in ("deepgram", "flux", "sarvam", "smallest"):
            out.append(f"VOICE_STT={self.stt_vendor} is not one of deepgram, flux, sarvam, smallest")
        if self.tts_vendor not in ("cartesia", "sarvam", "smallest"):
            out.append(f"VOICE_TTS={self.tts_vendor} is not one of cartesia, sarvam, smallest")
        for vendor in dict.fromkeys((self.stt_vendor, self.tts_vendor)):
            name, value = keys.get(vendor, (None, "x"))
            if name and not value:
                out.append(f"{name} is required for VOICE_STT/VOICE_TTS={vendor}")
        return out


def settings() -> Settings:
    return Settings()
