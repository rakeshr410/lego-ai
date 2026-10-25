"""What the pipeline watches about itself (design section 6, observability and heartbeats).

UsageObserver counts what the vendors bill: seconds of audio streamed to the transcriber, and characters sent
to the voice; it also keeps the words of the interviewer's current reply that actually played (for `played`
after an interruption) and which vendors have errored (degraded, reported in the heartbeat).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    ErrorFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    TTSTextFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameProcessor


class UsageObserver(BaseObserver):
    def __init__(
        self,
        *,
        audio_in: FrameProcessor | None,
        audio_out: FrameProcessor | None,
        stt: FrameProcessor | None,
        tts: FrameProcessor | None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._audio_in = audio_in
        self._audio_out = audio_out
        self._stt = stt
        self._tts = tts
        self.stt_seconds = 0.0
        self.tts_chars = 0
        self.degraded: set[str] = set()
        # The current reply's spoken words (TTSTextFrames the output transport has played), and the last reply's.
        self.spoken: list[str] = []
        self.last_spoken = ""
        self.interrupted = False
        # The drawing's pacer (bot/pacer.py): told of each word played, and when the reply stops playing.
        self.on_spoken: Callable[[], Awaitable[None]] | None = None
        self.on_stopped: Callable[[], Awaitable[None]] | None = None

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame
        if isinstance(frame, InputAudioRawFrame):
            if self._audio_in is None or data.source is self._audio_in:
                self.stt_seconds += len(frame.audio) / (2.0 * max(1, frame.num_channels) * max(1, frame.sample_rate))
        elif isinstance(frame, TTSTextFrame):
            if self._tts is not None and data.source is self._tts:
                self.tts_chars += len(frame.text)
            if self._audio_out is not None and data.source is self._audio_out:
                self.spoken.append(frame.text)
                if self.on_spoken:
                    await self.on_spoken()
        elif isinstance(frame, LLMFullResponseStartFrame):
            self.spoken = []
            self.interrupted = False
        elif isinstance(frame, InterruptionFrame):
            if self.spoken:
                self.interrupted = True
            if self.on_stopped:
                await self.on_stopped()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.last_spoken = " ".join(self.spoken).strip()
            if self.on_stopped:
                await self.on_stopped()
        elif isinstance(frame, ErrorFrame):
            if self._stt is not None and data.source is self._stt:
                self.degraded.add("stt")
            elif self._tts is not None and data.source is self._tts:
                self.degraded.add("tts")

    def spoken_text(self) -> str:
        return " ".join(self.spoken).strip()

    def spoken_words(self) -> int:
        """Words of the current reply that have played (what a drawing's anchor counts against)."""
        return len(" ".join(self.spoken).split())
