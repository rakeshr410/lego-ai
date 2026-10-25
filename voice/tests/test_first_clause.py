"""The voice gets the reply's first clause as soon as it is in, then whole sentences."""

import pytest
from pipecat.utils.text.base_text_aggregator import TextType

from bot.first_clause import FirstClauseAggregator


async def feed(agg: FirstClauseAggregator, chunks: list[str]) -> list[str]:
    out = []
    for c in chunks:
        async for a in agg.aggregate(c):
            out.append(a.text)
    return out


@pytest.mark.asyncio
async def test_the_first_clause_goes_out_early_and_the_rest_by_sentence() -> None:
    agg = FirstClauseAggregator(aggregation_type=TextType.SENTENCE)
    out = await feed(agg, ["So the users", " here are agents, and", " the load is spiky.", " Next, the API."])
    assert out == ["So the users here are agents,", "and the load is spiky."]
    assert (await agg.flush()).text == "Next, the API."
    # The next reply starts afresh: its first clause goes out early too.
    out = await feed(agg, ["Right, so the", " queue holds them, then", " the worker drains it."])
    assert out == ["Right, so the queue holds them,"]


@pytest.mark.asyncio
async def test_short_clauses_and_later_clauses_wait_for_the_sentence() -> None:
    agg = FirstClauseAggregator(aggregation_type=TextType.SENTENCE)
    # "Right," alone is too short to be worth a cut; the sentence goes out whole.
    out = await feed(agg, ["Right, we", " cache it. Then,", " the users wait, and", " the queue fills. Next"])
    assert out == ["Right, we cache it.", "Then, the users wait, and the queue fills."]
    # An interruption resets the reply.
    await agg.handle_interruption()
    assert agg.text.text == ""
    out = await feed(agg, ["Fine, so the", " users are agents, and more."])
    assert out == ["Fine, so the users are agents,"]
