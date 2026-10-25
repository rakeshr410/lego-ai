"""The rejoin window: a candidate who leaves gets a while to come back before the pipeline ends."""

import asyncio

import pytest

from bot.run import RejoinWindow


@pytest.mark.asyncio
async def test_a_rejoin_inside_the_window_cancels_the_end() -> None:
    gone = []

    async def on_gone() -> None:
        gone.append(True)

    w = RejoinWindow(0.05, on_gone)
    assert w.joined() is False
    w.left()
    await asyncio.sleep(0.01)
    assert w.joined() is True
    await asyncio.sleep(0.1)
    assert gone == []


@pytest.mark.asyncio
async def test_no_rejoin_ends_the_pipeline_once() -> None:
    gone = []

    async def on_gone() -> None:
        gone.append(True)

    w = RejoinWindow(0.02, on_gone)
    w.left()
    w.left()  # a second leave event restarts the one window
    await asyncio.sleep(0.1)
    assert gone == [True]
    assert w.joined() is False
