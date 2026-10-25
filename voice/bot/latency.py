"""Where the time goes between the candidate's last word and the interviewer's first (design section 6).

One line per exchange, so a slow reply can be blamed on the right leg: deciding the turn is over (VAD,
smart-turn, the transcript), the interviewer's first token (the web and the model), and the first audio
(the voice). Wall-clock seconds throughout, so the VAD's own timestamp lines up.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    InterimTranscriptionFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import TurnMetricsData
from pipecat.observers.base_observer import BaseObserver, FramePushed


@dataclass
class Exchange:
    speech_end: float | None = None  # the candidate's last word (VAD timestamp less its silence window)
    turn_end: float | None = None  # the pipeline decided the turn was over
    transcript: float | None = None  # the last final transcript before that
    first_token: float | None = None  # the interviewer's first word of text
    first_audio: float | None = None  # the first synthesized audio after the turn (a filler counts)
    spoke: float | None = None  # the bot started speaking
    predictions: list[tuple[bool, float, float]] = field(default_factory=list)  # smart-turn: complete, p, ms
    turns: int = 0  # candidate turns inside this exchange: more than one means the reply was fused (a cut-in)
    last_stop: int | None = None  # the last UserStoppedSpeakingFrame counted (each is pushed once per processor)

    def ms(self, a: float | None, b: float | None) -> int | None:
        return None if a is None or b is None else int(round((b - a) * 1000))

    def summary(self) -> dict[str, int | str | None]:
        last = self.predictions[-1] if self.predictions else None
        return {
            "eot_ms": self.ms(self.speech_end, self.turn_end),
            "transcript_ms": self.ms(self.speech_end, self.transcript),
            "ttft_ms": self.ms(self.turn_end, self.first_token),
            "first_audio_ms": self.ms(self.turn_end, self.first_audio),
            "total_ms": self.ms(self.speech_end, self.spoke),
            "filler": "yes" if self.first_audio and self.first_token and self.first_audio < self.first_token else "no",
            "smart_turn": None
            if last is None
            else f"{'complete' if last[0] else 'incomplete'} p={last[1]:.2f} {last[2]:.0f}ms",
            "smart_turn_runs": len(self.predictions),
            "turns": self.turns,
        }


class LatencyObserver(BaseObserver):
    """Logs one `voice latency` line per exchange and keeps the summaries (`exchanges`)."""

    def __init__(self, sid: str, *, clock=time.time, **kwargs):
        super().__init__(**kwargs)
        self._sid = sid
        self._clock = clock
        self._cur = Exchange()
        self.exchanges: list[dict[str, int | str | None]] = []

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame
        now = self._clock()
        cur = self._cur
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            if cur.turn_end is None:
                cur.speech_end = frame.timestamp - frame.stop_secs
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            if cur.turn_end is None:
                cur.speech_end = None  # the candidate went on; the pause was not the end
                cur.predictions.clear()
        elif isinstance(frame, MetricsFrame):
            for m in frame.data:
                if isinstance(m, TurnMetricsData) and cur.turn_end is None:
                    cur.predictions.append((m.is_complete, m.probability, m.e2e_processing_time_ms))
        elif isinstance(frame, TranscriptionFrame) and not isinstance(frame, InterimTranscriptionFrame):
            if cur.turn_end is None:
                cur.transcript = now
        elif isinstance(frame, UserStoppedSpeakingFrame):
            if cur.speech_end is not None and frame.id != cur.last_stop:
                cur.last_stop = frame.id
                cur.turns += 1
            if cur.turn_end is None and cur.speech_end is not None:
                cur.turn_end = now
        elif isinstance(frame, LLMFullResponseStartFrame):
            pass
        elif isinstance(frame, LLMTextFrame):
            if cur.turn_end is not None and cur.first_token is None:
                cur.first_token = now
        elif isinstance(frame, TTSAudioRawFrame):
            if cur.turn_end is not None and cur.first_audio is None:
                cur.first_audio = now
        elif isinstance(frame, BotStartedSpeakingFrame):
            if cur.turn_end is not None and cur.spoke is None:
                cur.spoke = now
                self._close()

    def _close(self) -> None:
        s = self._cur.summary()
        self.exchanges.append(s)
        logger.info(
            "voice latency {} total={}ms eot={}ms (transcript {}ms, smart-turn {} x{}) "
            "ttft={}ms first_audio={}ms filler={} turns={}",
            self._sid,
            s["total_ms"],
            s["eot_ms"],
            s["transcript_ms"],
            s["smart_turn"],
            s["smart_turn_runs"],
            s["ttft_ms"],
            s["first_audio_ms"],
            s["filler"],
            s["turns"],
        )
        self._cur = Exchange()
