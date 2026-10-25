"""The voice starts on the reply's first clause (README "Latency").

Pipecat's TTS services hand the voice one sentence at a time, so the first sound waits for the model
to finish its first sentence: at a spoken reply's pace that is 0.2 to 0.4 s after the first token.
This aggregator releases the first clause instead, at a comma, semicolon or colon once four words
are in ("Right, so the users here are agents," is spoken while "and the load is spiky." arrives), then
goes back to sentences. A clause read on its own ends a little early in prosody; the first words a
quarter second sooner are worth it. One clause per reply: the flag resets when the reply ends or is
cut off.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator

from pipecat.services.tts_service import TTSService
from pipecat.utils.text.base_text_aggregator import Aggregation, TextType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator, _LookaheadState

CLAUSE_END = re.compile(r"[,;:]\s$")


class FirstClauseAggregator(SimpleTextAggregator):
    def __init__(self, *, min_words: int = 4, **kwargs):
        super().__init__(**kwargs)
        self._min_words = min_words
        self._opened = False  # something of this reply has gone to the voice

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        if self._aggregation_type == TextType.TOKEN:
            async for a in super().aggregate(text):
                yield a
            return
        for char in text:
            self._text += char
            result = await self._check_sentence_with_lookahead(char)
            if result:
                self._opened = True
                yield result
            elif not self._opened and self._clause_ready():
                clause = self._text.strip(" ")
                self._text = ""
                self._lookahead_state = _LookaheadState.IDLE
                self._opened = True
                yield Aggregation(text=clause, type=TextType.SENTENCE)

    def _clause_ready(self) -> bool:
        return bool(CLAUSE_END.search(self._text)) and len(self._text.split()) >= self._min_words

    async def flush(self) -> Aggregation | None:
        self._opened = False
        return await super().flush()

    async def handle_interruption(self):
        self._opened = False
        await super().handle_interruption()


def install_first_clause(tts: TTSService) -> None:
    """Swaps the service's sentence aggregator for the first-clause one (Pipecat 1.13 keeps it as
    `_text_aggregator`; a service without one is left alone)."""
    current = getattr(tts, "_text_aggregator", None)
    if not isinstance(current, SimpleTextAggregator):
        return
    tts._text_aggregator = FirstClauseAggregator(  # noqa: SLF001 - the service has no setter
        aggregation_type=current._aggregation_type,  # noqa: SLF001
        language=current.language,
    )
