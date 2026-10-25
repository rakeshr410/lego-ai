"""The speech vendors are picked from the environment, and a vendor without its key is refused at start."""

import pytest
from pipecat.transcriptions.language import Language

from app.config import Settings
from bot.first_clause import FirstClauseAggregator
from bot.vendors import build_stt, build_tts


def test_vendor_defaults_and_problems(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("VOICE_STT", "VOICE_TTS", "SARVAM_API_KEY", "SMALLEST_API_KEY", "VOICE_SPECULATE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("INTERVIEW_VOICE_SECRET", "x" * 32)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg")
    monkeypatch.setenv("CARTESIA_API_KEY", "ca")
    s = Settings()
    assert (s.stt_vendor, s.tts_vendor, s.speculate) == ("deepgram", "cartesia", True)
    assert s.problems() == []
    monkeypatch.setenv("VOICE_STT", "sarvam")
    monkeypatch.setenv("VOICE_TTS", "Smallest")
    monkeypatch.setenv("VOICE_SPECULATE", "false")
    s = Settings()
    assert s.speculate is False
    assert s.problems() == [
        "SARVAM_API_KEY is required for VOICE_STT/VOICE_TTS=sarvam",
        "SMALLEST_API_KEY is required for VOICE_STT/VOICE_TTS=smallest",
    ]
    monkeypatch.setenv("VOICE_STT", "whisper")
    assert Settings().problems()[0].startswith("VOICE_STT=whisper is not one of")


def test_each_vendor_builds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg")
    monkeypatch.setenv("CARTESIA_API_KEY", "ca")
    monkeypatch.setenv("SARVAM_API_KEY", "sa")
    monkeypatch.setenv("SMALLEST_API_KEY", "sm")
    monkeypatch.setenv("SARVAM_PACE", "0.1")
    for stt, tts in (("deepgram", "cartesia"), ("flux", "cartesia"), ("sarvam", "sarvam"), ("smallest", "smallest")):
        monkeypatch.setenv("VOICE_STT", stt)
        monkeypatch.setenv("VOICE_TTS", tts)
        s = Settings()
        assert build_stt(s, Language.EN_IN) is not None
        tts_service = build_tts(s)
        # The voice starts on the first clause (bot/first_clause.py) unless turned off.
        assert isinstance(tts_service._text_aggregator, FirstClauseAggregator)  # noqa: SLF001
    monkeypatch.setenv("VOICE_FIRST_CLAUSE", "false")
    assert not isinstance(build_tts(Settings())._text_aggregator, FirstClauseAggregator)  # noqa: SLF001
    assert Settings().sarvam_pace == 0.5
    # Flux's thresholds reach its settings; unset ones are left to Deepgram.
    monkeypatch.setenv("VOICE_STT", "flux")
    monkeypatch.setenv("DEEPGRAM_FLUX_EOT", "0.6")
    flux = build_stt(Settings(), Language.EN)
    assert flux._settings.eot_threshold == 0.6 and flux.eager_end_of_turn_enabled  # noqa: SLF001
    assert flux._settings.eager_eot_threshold == 0.3  # noqa: SLF001 - predicts early
    monkeypatch.setenv("VOICE_SPECULATE", "false")
    flux = build_stt(Settings(), Language.EN)
    assert not flux.eager_end_of_turn_enabled and flux._settings.eager_eot_threshold is None  # noqa: SLF001
    assert "DEEPGRAM_API_KEY is required for VOICE_STT/VOICE_TTS=flux" in Settings(deepgram_api_key="").problems()
    monkeypatch.setenv("VOICE_TTS", "nobody")
    with pytest.raises(ValueError):
        build_tts(Settings())
