"""What the pipeline watches about itself (design section 6, observability and heartbeats).

UsageObserver counts what the vendors bill: seconds of audio streamed to the transcriber, and characters sent
to the voice; it also keeps the words the voice played lately (an echo of them is not the candidate), the
words of the interviewer's current reply that actually played (for `played` after an interruption) and which
vendors have errored (degraded, reported in the heartbeat).
"""

from __future__ import annotations

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    ErrorFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TTSTextFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameProcessor

from bot.conductor import SegmentEndFrame, SegmentStartFrame
from bot.echo import VoiceMemory


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
        # A reply is being played: its start has reached the speaker and its end has not (the end comes out after
        # the audio before it; a cut-in drops it, so a cut reply stays "playing" until the next one starts).
        self.playing = False
        # Every word the voice played lately, labels too: what an echo of it would be (bot/echo.py).
        self.memory = VoiceMemory()

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame
        if self._audio_out is not None and data.source is self._audio_out:
            if isinstance(frame, LLMFullResponseStartFrame) and not isinstance(frame, SegmentStartFrame):
                self.playing = True
            elif isinstance(frame, LLMFullResponseEndFrame) and not isinstance(frame, SegmentEndFrame):
                self.playing = False
        if isinstance(frame, InputAudioRawFrame):
            if self._audio_in is None or data.source is self._audio_in:
                self.stt_seconds += len(frame.audio) / (2.0 * max(1, frame.num_channels) * max(1, frame.sample_rate))
        elif isinstance(frame, TTSTextFrame):
            if self._tts is not None and data.source is self._tts:
                self.tts_chars += len(frame.text)
            if self._audio_out is not None and data.source is self._audio_out:
                self.memory.played(frame.text)
            # A label the voice read as the pen wrote it (bot/conductor.py) is not one of the reply's words.
            if (
                self._audio_out is not None
                and data.source is self._audio_out
                and not getattr(frame, "pen_label", False)
            ):
                self.spoken.append(frame.text)
        elif isinstance(frame, LLMFullResponseStartFrame) and not isinstance(frame, SegmentStartFrame):
            self.spoken = []
            self.interrupted = False
        elif isinstance(frame, InterruptionFrame):
            if self.spoken:
                self.interrupted = True
        elif isinstance(frame, BotStartedSpeakingFrame):
            self.memory.started()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.memory.stopped()
            self.last_spoken = " ".join(self.spoken).strip()
        elif isinstance(frame, ErrorFrame):
            if self._stt is not None and data.source is self._stt:
                self.degraded.add("stt")
            elif self._tts is not None and data.source is self._tts:
                self.degraded.add("tts")

    def spoken_text(self) -> str:
        return " ".join(self.spoken).strip()
