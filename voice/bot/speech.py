"""Scripted lines the pipeline speaks without a model call (design section 6): fillers while a reply is on its
way, bridges around reconnects and stage changes, and the closing lines. All are spoken with
`append_to_context=False`: the interviewer's transcript on the web is the record, and these are not part of it.
"""

from __future__ import annotations

import random

FILLERS = [
    "Right.",
    "Okay.",
    "Mm-hm, go on.",
    "Let me think about that for a second.",
    "Okay, got it.",
]

MISSED = "Sorry, I missed that. Could you say it again?"
RECONNECT_BRIDGE = "One moment, I need to reconnect. Stay on the line."
DEGRADED_STT = "I'm having trouble hearing you. If this keeps up, you can type your answers in the room."
DEGRADED_TTS = "My voice is cutting out. You can keep reading my replies in the room."

CLOSING = {
    "time": "That's all the time we have. Thank you; your written feedback is being prepared in the room.",
    "turns": "That's as far as this session goes. Thank you; your written feedback is being prepared in the room.",
    "budget": "We'll have to stop there. Thank you; your written feedback is being prepared in the room.",
    "done": "Thank you, that's the end of the interview. Your written feedback is being prepared in the room.",
    "voice_budget": "The voice room has to close for today. You can carry on by typing, and get your feedback in the room.",
    "disabled": "The voice room is closing. You can carry on by typing, and get your feedback in the room.",
}


# A coach lesson (docs/coach-mode.md) ends on its summary, not on feedback.
CLOSING_COACH = {
    "time": "That's all the time we have for this lesson. Thank you; what you understood is summed up in the room.",
    "turns": "That's as far as this lesson goes. Thank you; what you understood is summed up in the room.",
    "budget": "We'll have to stop the lesson there. Thank you; what you understood is summed up in the room.",
    "done": "That's the end of the lesson. Well done; what you understood is summed up in the room.",
    "voice_budget": "The voice room has to close for today. You can carry on the lesson by typing in the room.",
    "disabled": "The voice room is closing. You can carry on the lesson by typing in the room.",
}

# A coach's move that could not be fetched: said once, and the silence after it asks again.
MOMENT = "Give me a moment."


def filler(rng: random.Random | None = None) -> str:
    return (rng or random).choice(FILLERS)


def closing(reason: str | None, kind: str = "interview") -> str:
    lines = CLOSING_COACH if kind == "coach" else CLOSING
    return lines.get(reason or "done", lines["done"])
