# interview-voice

The mock interview's voice service (design section 6; [docs/interview/README.md](../docs/interview/README.md),
"Voice"). One Pipecat pipeline per voice session: Daily carries the audio, Deepgram transcribes, Cartesia
speaks. The **web tier owns the session**: the transcript, the prompt, the director, every model call, the
quota and the budget. This service posts each spoken turn to the web's internal routes, speaks the reply as
it streams back, and reports its usage in heartbeats. It keeps no state of its own beyond the pipelines it
is running.

```
Daily room ──audio──▶ DailyTransport.input ─▶ RTVI ─▶ Deepgram STT ─▶ TurnShaper ─▶ user aggregator (Silero VAD, smart-turn v3)
                                                                                             │
                                                                                             ▼
Daily room ◀──audio── DailyTransport.output ◀─ Cartesia TTS ◀─ GatewayLLMService ──POST /api/internal/interview/:id/turns (SSE)──▶ web
                            │
                            └─▶ assistant aggregator ─▶ IdleGate (silence rungs → POST …/idle)
```

## Routes (bearer `INTERVIEW_VOICE_SECRET`)

| Route | What |
|---|---|
| `POST /sessions` | `{sid, attach, room: {url, token}, language, audioOptIn, plannedMinutes, kind, turnStopSecs?}`: starts a pipeline, 202 `{task}`; 503 when this task has no slot. `kind` is `interview` or `coach` (a lesson, docs/interview/coach-mode.md: the bot is "Coach", its closing lines differ); `turnStopSecs` overrides `VOICE_TURN_STOP_SECS` for the session (a lesson sends 3) |
| `GET /sessions/{sid}` | 200 `{running, task}` while this task runs the session's pipeline, 404 otherwise: the web asks before trusting a lease on a rejoin, so a crashed or restarted service is replaced at once |
| `DELETE /sessions/{sid}` | stops the session's pipeline (the candidate ended the voice part) |
| `GET /health` | up |
| `GET /ready` | 200 with capacity; 503 while draining or full |

## What the pipeline does

- **Attach** with the one-use token the web minted; the web answers the epoch, the stage and the words to speak first.
  A `busy` refusal is waited out (the web still holds the session's lock while it starts this pipeline, or a
  reply is in flight: up to 20 tries, half a second apart); any other refusal ends the pipeline.
- **Turns**: the user aggregator's turn goes to `/turns` with `(epoch, seq)`; the reply streams back and is
  spoken from its first clause, then sentence by sentence. A filler ("Right.") is spoken when the first
  words take more than `VOICE_FILLER_AFTER_SECS` (0: never, the default). A cut-in drops the stream: the web
  keeps the exchange as far as it got, then `/played` says which words were heard ("Cut-ins", below).
- **Silence**: 20, 35, 60 and 120 s after the interviewer's last word, `/idle` is called and whatever the web
  answers is spoken. Nothing is advanced on silence.
- **A lesson drives itself** (coach mode): the attach state and every turn's state carry `selfDrive`, seconds
  of silence after the coach's last word before the pipeline posts `/turns` with `kind: "continue"` and no
  text (a short beat after a move that waits for no answer, a long one after a question the learner left).
  The move streams and is spoken like a reply, under the same lock and cut-in handling, with no filler; a
  lesson's idle rungs are empty. A lesson that has not opened gets its first move when the learner joins.
  The reply stream's `draw` event (the coach's drawing) is forwarded to the room as an RTVI server message
  `{kind: "draw", ops}`, which the room's board applies while the words are spoken.
- **Heartbeats** every `VOICE_HEARTBEAT_SECS`: seconds of audio streamed to Deepgram and characters sent to
  Cartesia (cumulative for the epoch), and degraded vendors. The web charges them at list prices and answers
  whether the session still takes turns; when it doesn't, the closing line is spoken and the pipeline ends.
- **Ending**: the candidate leaving the room (after a 10 s window for a rejoin: a reload comes back with a fresh
  token), a transport error, or a SIGTERM (the service parks every session, then exits on its own) park the session (`detach
  transport`): the clock stops and the room rejoins within 15 minutes on any task. A closed session or a stale
  epoch ends the voice part (`detach ended`).

## Settings

| Variable | Default | What |
|---|---|---|
| `INTERVIEW_WEB_URL` | `http://web.internal:4321` | the web tier on the private network |
| `INTERVIEW_VOICE_SECRET` | | the bearer, both ways (32+ characters; the same value the web has) |
| `VOICE_STT`, `VOICE_TTS` | `deepgram`, `cartesia` | who transcribes (`deepgram`, `sarvam`, `smallest`) and who speaks (`cartesia`, `sarvam`, `smallest`); bot/vendors.py. Deepgram and Cartesia serve from the US, Sarvam and Smallest from India (about 0.2 s less on each leg from Mumbai or Bengaluru) |
| `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `SARVAM_API_KEY`, `SMALLEST_API_KEY` | | the chosen vendors' keys (the Daily key is the web's: it mints the bot's room token) |
| `DEEPGRAM_MODEL` | `nova-3` | |
| `CARTESIA_MODEL`, `CARTESIA_VOICE_ID` | `sonic-3`, "Kiara - Joyful Woman" (Indian-accented English, female) | the male counterpart is "Devansh - Warm Support Agent", `1259b7e3-cb8a-43df-9446-30971a46b8b0` |
| `CARTESIA_SPEED` | 0.85 | the interviewer's pace, sonic-3's speed multiplier (0.6 slow to 1.5 fast) |
| `SARVAM_STT_MODEL`, `SARVAM_TTS_MODEL` | `saaras:v3-realtime`, `bulbul:v3` | Sarvam's streaming transcriber (en-IN) and voice model (`bulbul:v4-flash` has its own speakers) |
| `SARVAM_SPEAKER`, `SARVAM_PACE` | `priya`, 1.1 | a bulbul:v3 speaker (ritu, priya, neha, pooja, simran, kavya, ishita, shreya, roopa read as female; pick by ear) and the pace (0.5 to 2) |
| `SMALLEST_STT_MODEL`, `SMALLEST_TTS_MODEL` | `pulse`, `lightning_v3.1_pro` | Smallest's transcriber (`pulse-2` is English-only) and voice model |
| `SMALLEST_VOICE`, `SMALLEST_SPEED` | `meher`, 1.0 | a voice of that model (Pro's Indian English female voices: rhea, zariya, kareena, mishka, inaaya, saira, meher, aarini) and the speed (0.5 to 2) |
| `VOICE_TURN_STOP_SECS` | 2.0 | the pause that ends a turn when smart-turn hears the candidate as not finished (0.8 to 5) |
| `VOICE_SPECULATE` | true | the speculative start (below): the words heard go to the web at the VAD's stop, or at Flux's prediction |
| `DEEPGRAM_FLUX_MODEL`, `DEEPGRAM_FLUX_EOT`, `DEEPGRAM_FLUX_EAGER_EOT` | `flux-general-en`, Deepgram's 0.7, 0.3 | `VOICE_STT=flux`: Deepgram Flux ends the turn itself (no smart-turn) and predicts the end first; the confidences (0 to 1) at which it commits and at which it predicts |
| `VOICE_FIRST_CLAUSE` | true | the voice starts on the reply's first clause (a comma after four words) rather than its first sentence (bot/first_clause.py) |
| `VOICE_MAX_SESSIONS_PER_TASK` | 4 | sessions one task runs at once (bench on staging before raising) |
| `VOICE_HEARTBEAT_SECS` | 15 | |
| `VOICE_FILLER_AFTER_SECS` | 0 | a scripted filler when the first words are later than this; 0 never |
| `VOICE_IDLE_TIMEOUT_SECS` | 900 | a pipeline with no frames at all this long parks the session |
| `VOICE_AUDIO_DIR` | unset | where opted-in raw audio would be written (not wired: the beta stores none) |
| `PORT` | 7860 | |

## Develop

```sh
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
INTERVIEW_WEB_URL=http://localhost:4321 INTERVIEW_VOICE_SECRET=… DEEPGRAM_API_KEY=… CARTESIA_API_KEY=… .venv/bin/python -m app.main
```

The tests fake the web at httpx's mock transport and run the processors through Pipecat's own test harness;
nothing reaches a vendor. The docker-compose `voice` profile at the repository root runs the service beside
the web with `INTERVIEW_VOICE_URL=http://voice:7860`.

## Latency

Every exchange logs one `voice latency` line: `total` (the candidate's last word to the interviewer's
first), `eot` (deciding the turn was over: the 0.2 s VAD window, smart-turn's verdict and, when it hears
the candidate as unfinished, up to `VOICE_TURN_STOP_SECS` of silence; `transcript` is Deepgram's final),
`ttft` (the web's turn route and the model's first token; the web logs `prepMs` and `firstTokenMs` on
the same call) and `first_audio` (the voice's first bytes; `filler=yes` when a scripted filler played
first, after `VOICE_FILLER_AFTER_SECS`). Read `eot` first: a run of `smart-turn incomplete` verdicts
means the candidate's pauses sound unfinished and the turn waits the full stop window.

**The speculative start** (`VOICE_SPECULATE`, bot/speculate.py; the web's prefetch.ts). The VAD hears
the candidate stop 0.2 s after their last word; the turn is confirmed 0.3 to 0.7 s later, once the
transcriber's final words are in and smart-turn has ruled. At the stop the pipeline posts the words
heard so far (`POST turns {speculative: true}`) and the web starts the model on them; a final that
lands after the stop and changes the words is posted again. A confirmed turn with the same or nearly
the same words (capitals and punctuation aside, and at most one word in seven apart: the interim at
the stop tends to lack the final's last word) takes over that stream, so the model's first token is
that much nearer; other words drop the guess, at the cost of one unused call. No guess is made while a
reply is in flight. The web logs each guess's fate as `interview_prefetch` (`hit`, `mismatch`,
`replaced`, `expired`), and its model call as `ask_call … speculative: true`.

**Cut-ins.** When the candidate speaks over a reply, the pipeline drops the reply's stream and the web
keeps the exchange as far as it got (their words, the words of the reply that streamed, marked cut;
`played` then trims it to the words heard), so the next turn is answered at once rather than after the
reply's end. A turn the web refuses as busy, the cut-off still being saved, is sent again after 0.15 s.

**Deepgram Flux** (`VOICE_STT=flux`). Flux is Deepgram's conversational transcriber: it decides where
the turn ends from the speech itself (its `EndOfTurn`, about 0.25 s after the last word, with the final
words in the same message), so neither smart-turn nor the wait for a final transcript applies, and it
predicts the end first (`EagerEndOfTurn`), which the speculative start posts as its guess: the
prediction carries the whole turn as heard, where an interim at the VAD's stop lags the final by a word
or two. Pipecat's own eager strategy, which would run an inference in the pipeline, is not used.

**The vendors' regions.** The service runs in Mumbai and the candidates are in India; Deepgram and
Cartesia answer from the US (about 0.2 s of wire on each leg), Sarvam and Smallest from India. Switch
with `VOICE_STT` and `VOICE_TTS` and compare `transcript`/`eot` and `first_audio` on the latency line.
Measured 2026-10-24: `VOICE_STT=sarvam` (saaras:v3-realtime under the pipeline's endpointing) heard one
or two words of each sentence (`LOG_LEVEL=DEBUG` prints each shaped final as `voice heard:`), so it is
not used; `VOICE_TTS=sarvam` starts speaking 0.2 to 0.6 s after the first token, Cartesia 0.4 to 0.9 s.
The model's leg moves the same way with the web's `LLM_PROVIDER=bedrock` (Claude in Amazon Bedrock from
ap-south-1; web/.env.example).
