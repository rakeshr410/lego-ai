# ADR 0005: Voice interviews keep the session on the web tier; a Pipecat service owns the audio

- **Status:** Accepted, 2026-10-23
- **Extends:** [ADR 0003](0003-section-driven-interviews.md) (the web tier owns the session) and
  [ADR 0004](0004-interview-whiteboard.md) (the board stays as it is in a voice session)
- **Design:** [docs/README.md](../README.md), "Voice"; the AI interviewer
  design note (Arrowbox, 22 October 2026), section 6; owner decisions of 2026-10-22: Pro only,
  five 45-minute sessions a month, realistic mode only, English (Indian English), desktop only
- **Code:** `web/src/lib/server/interview/voice.ts`, `voice-token.ts`, `daily.ts`,
  `voice-client.ts`, `web/src/pages/api/internal/interview/[id]/[action].ts`,
  `web/src/components/sd/VoiceRoom.tsx`, `web/src/lib/voice-call.ts`, `interview-voice/`

## Context

The text room runs the interview as a sequence of saved turns rendered into one cached prompt
(ADR 0003). Voice adds a real-time audio loop: voice activity detection, speech-to-text,
text-to-speech, turn-taking and barge-in, with a latency budget of about 1.5 s from the end of
speech to the first audio. None of that belongs in a Node web process that also serves pages, and
none of the session's state belongs in a process that can be stopped with two minutes' notice
(Fargate Spot) or replaced by a deploy.

Two shapes were open: a realtime speech model (one vendor, per-minute pricing, the interviewer's
prompts and grading rewritten for it), or speech-to-text, the same Claude interviewer, and
text-to-speech. The second keeps the prompts, the director, the evidence ledger and the grader
unchanged, and keeps the transcript the grader reads identical in kind to the text room's.

## Decision

1. **The web tier still owns the session.** Start, consent, quota, the stage machine, the clock,
   every model call, the transcript, the budgets and the switches stay in `web/`. The voice
   service holds no prompt text, no Redis connection and no vendor key but its own two.
2. **A separate service owns the audio loop, and only that.** `interview-voice` (Python, Pipecat
   1.13): Daily WebRTC transport, Deepgram Nova-3, Cartesia Sonic-3, Silero VAD with smart-turn,
   one pipeline per session, at most `VOICE_MAX_SESSIONS_PER_TASK` per task. Its "LLM" is a
   gateway that posts the candidate's turn to the web's internal route and speaks the reply the
   web streams back from the same `replyRequest()` the text room uses.
3. **Leases fence the two.** Each attach is a new epoch; the lease is renewed by turns and
   heartbeats and stands a minute. The text room's controls answer 409 `voice_live` while it
   stands; a pipeline with an old epoch is refused with 409 `stale_epoch`; turns carry a sequence
   number. The attach credential is signed, single-use and short-lived. A lost task or a dropped
   line parks the session (the clock stops for up to 15 minutes) and the room rejoins on any task,
   because the pipeline is rebuilt from the saved turns.
4. **An interruption is kept whole.** The gateway reads the reply stream to its end so the web
   saves the whole exchange, then reports the words the candidate heard; the web trims the saved
   turn to them and marks it interrupted. The grader therefore reads what was said, not what was
   generated.
5. **Speech is charged with the tokens.** Heartbeats carry the audio seconds and characters since
   the attach; the web charges them at list prices into the session's cost and the daily budgets,
   so one dollar cap and one breaker cover tokens and speech.
6. **Pro only, five sessions and 225 minutes a month, English, desktop.** Free readers see voice
   as a Pro feature and keep the text interview. The quota is counted at start and given back if
   the start fails.

## Consequences

- One more image, service, security group and four secrets (infra `voice`), on staging only
  until the gates in the README pass. The web becomes a Service Connect server (`web.internal`).
- The room page relaxes two headers in a voice build: `microphone=(self)` and Daily's hosts in
  `script-src` and `connect-src`; every other page keeps the site's policy.
- The consent text gains the speech vendors, the microphone and an optional audio opt-in; it needs
  counsel's review before readers see it (privacy.md). No raw audio is stored by default.
- Deferred: a realtime speech model if measured latency demands it; the interviewer drawing on the
  board; languages beyond English; mobile.
