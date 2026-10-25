"""Shapes the candidate's transcribed turns before they reach the interviewer (design section 6).

Deepgram's finals arrive as fragments; the user aggregator joins them into one turn. This processor
cleans each fragment: whitespace, hesitation sounds at the edges, and a fragment that is nothing but
hesitation is dropped so it never opens a turn on its own.
"""

from __future__ import annotations

import re

from loguru import logger
from pipecat.frames.frames import Frame, InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

HESITATION = re.compile(r"^(?:\s*(?:um+|uh+|erm+|hmm+|mm+|ah+|er+)[,.!?]?\s*)+$", re.IGNORECASE)
EDGE_HESITATION = re.compile(
    r"^(?:\s*(?:um+|uh+|erm+|hmm+|mm+)[,.]?\s+)+|(?:\s+(?:um+|uh+|erm+|hmm+|mm+)[,.]?\s*)+$", re.IGNORECASE
)
SPACES = re.compile(r"\s+")


def shape(text: str) -> str:
    """The fragment cleaned, or "" when it carried no words."""
    t = SPACES.sub(" ", text).strip()
    if not t or HESITATION.match(t):
        return ""
    t = EDGE_HESITATION.sub("", t).strip()
    return t


class TurnShaper(FrameProcessor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.dropped = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and not isinstance(frame, InterimTranscriptionFrame):
            text = shape(frame.text)
            if not text:
                self.dropped += 1
                return
            frame.text = text
            logger.debug("voice heard: {}", text)  # what the transcriber made of the candidate (LOG_LEVEL=DEBUG)
        await self.push_frame(frame, direction)
