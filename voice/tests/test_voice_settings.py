"""The interviewer's voice and pace come from the environment, within Cartesia's range."""

import pytest

from app.config import Settings


def test_voice_and_pace_defaults_and_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CARTESIA_VOICE_ID", raising=False)
    monkeypatch.delenv("CARTESIA_SPEED", raising=False)
    s = Settings()
    assert s.cartesia_voice_id == "f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d"
    assert s.cartesia_speed == 0.85
    monkeypatch.setenv("CARTESIA_SPEED", "0.2")
    assert Settings().cartesia_speed == 0.6
    monkeypatch.setenv("CARTESIA_SPEED", "1.1")
    monkeypatch.setenv("CARTESIA_VOICE_ID", "1259b7e3-cb8a-43df-9446-30971a46b8b0")
    s = Settings()
    assert (s.cartesia_speed, s.cartesia_voice_id) == (1.1, "1259b7e3-cb8a-43df-9446-30971a46b8b0")
