# Mock interview: cost model and session quotas

What one mock interview costs, what a month of them costs at three adoption levels, and how each
control in the code follows from that (P3-11, GAP3-3). The design is in [README.md](README.md);
Ask's own model is in [../capacity-model.md](../capacity-model.md), whose traffic assumptions (20,000
monthly active users) this reuses.

**All figures are estimates** from list prices and measured prompt sizes, not from billing. Replace
them with measured numbers from the first beta week (below, "Re-measuring").

## Prices and sizes used

| Input | Value | Source |
|---|---|---|
| Turn model | Claude Sonnet 5: $2 / M input, $10 / M output, $0.20 / M cache read, cache write 1.25x input | `MODELS` in `web/src/lib/server/llm-gateway.ts`; `INTERVIEW_MODEL` |
| Feedback model | Claude Opus 5: $5 / M input, $25 / M output | `INTERVIEW_FEEDBACK_MODEL` |
| Interviewer system prompt | 11.8k characters, about **3.5k tokens** (rules, the whole Instagram plan, two topic briefs) | measured, `interviewerSystem()` |
| Grader system prompt | 8.2k characters, about **2.3k tokens** | measured, `feedbackRequest()` |
| One exchange | about **260 tokens** of transcript (an 80-token answer in its tag, a 160-token reply) | assumption: replies are held under 120 words |
| Reply output | about **310 tokens** (160 of text, about 150 of low-effort thinking) | assumption; `INTERVIEW_MAX_TOKENS` 700 is the cap |
| Feedback output | about **1.5k tokens** (JSON plus thinking) | assumption; `INTERVIEW_FEEDBACK_MAX_TOKENS` 4000 is the cap |
| Typical session | **20** candidate messages | assumption: one every 2 minutes over 40 minutes |
| Heavy session | **60** messages (the `INTERVIEW_MAX_TURNS` cap), every reply at the 700-token cap | the worst case the caps allow |

Starting a session, each stage's opener and moving on cost nothing: they are written in the plan.

## One session

Each reply reads the system prompt and the transcript so far from the prompt cache (the system
block is shared by every candidate on the system; the transcript by the session's own earlier
turns) and writes only the newest turn. Turn n (from 0) reads about 3,500 + 260n tokens.

| | Typical (20 messages) | Heavy (60, at the caps) | Typical with caching broken |
|---|---|---|---|
| Cache reads | 119k tokens: **$0.024** | 670k: **$0.134** | 119k at the input price: **$0.239** |
| Cache writes | 5.2k: **$0.013** | 15.6k: **$0.039** | none |
| Reply output | 6.2k: **$0.062** | 42k: **$0.420** | **$0.062** |
| Feedback input (Opus 5) | 8k: **$0.040** | 18k: **$0.090** | **$0.040** |
| Feedback output | 1.5k: **$0.038** | 4k: **$0.100** | **$0.038** |
| **Session** | **about $0.18** | **about $0.78** | **about $0.38** |

For scale: an Ask question costs about $0.030 at launch ([capacity model](../capacity-model.md)), so
a typical interview costs about six questions and the heaviest one the caps allow about 26. That
is far below GAP3-3's "1-2 orders of magnitude" worry because the turns run on the cheaper model
with the prefix cached and only the feedback uses the premium one. The first reply on a system
after 5 quiet minutes also writes the system prompt to the cache (about $0.009).

If Opus 5 ran the turns as well, the typical session would be about $0.33; Sonnet 5 for the
feedback too, about $0.13. Which model grades is a quality decision (see "Open questions" in the
README): measure it with the grader eval before changing it.

## A month

| Scenario | Adoption | Sessions a month | At $0.18 (typical) | Ceiling at $0.78 |
|---|---|---|---|---|
| Low | 5% of 20k MAU try it, 1.2 sessions each | 1,200 | **$220** | $940 |
| Expected | 15%, 2 sessions each | 6,000 | **$1,080** | $4,700 |
| High | 30%, 3 each (the free quota) | 18,000 | **$3,240** | $14,000 |

Next to Ask's modelled $6.8k a month, the expected interview line is about 15% more LLM spend.

## Controls, and how to size them

| Control | Setting (default) | Why that default | For production |
|---|---|---|---|
| Sessions per reader per month (UTC) | `INTERVIEW_MONTHLY_SESSIONS` (3) | Caps the high scenario at 3 per reader; counted at start, given back if the start fails | Keep 3 on free; the paid plan (P3-8) raises it |
| Voice top-ups | `interview:voice:topups:<reader>` (granted by hand: `interview-switch.mjs topups`) | A whole voice session past the month's five; its own session caps bound it, no monthly minutes reserved. Price and purchase flow are open (no one-off Razorpay orders yet) | Count granted top-ups in the voice month model at a session's cost each |
| Drills per reader per month (UTC) | `INTERVIEW_MONTHLY_DRILLS` (30) | A drill is a 7- or 13-minute session on the same prompts: about a sixth to a third of a whole session's cost, so 30 drills cost about as much as 5 to 10 sessions; counted and refunded like sessions | Re-measure with `interview:cost` once drills run; a voice drill also spends voice minutes |
| Messages per session | `INTERVIEW_MAX_TURNS` (60) | 3x a typical session; bounds the heavy case | Lower if analytics show sessions rarely pass 30 |
| Dollars per session | `INTERVIEW_SESSION_BUDGET_USD` (1.50) | About 2x the heavy case: it binds only when something is wrong (caching broken, a prompt grown by mistake, or replies stopped over and over). Every call that may have been billed counts, saved or not: a stopped, timed-out or dropped reply at the gateway's conservative estimate (about $0.01-0.02 on Sonnet 5 at the 700-token cap), so no more than about 100 stopped replies fit in a session | Keep at about 2x the measured heavy session |
| Feedback attempts per session | 3 (`MAX_FEEDBACK_ATTEMPTS`) | The feedback runs even when the dollar cap has closed the session; each billed attempt (about $0.15-0.25 on Opus 5 at the gateway's estimate) is charged, and after three that fail the session ends without feedback | Keep |
| Length | planned minutes + `INTERVIEW_OVERTIME_MINUTES` (45 + 15) | After that the session takes no messages; feedback still runs | Keep |
| One paid call at a time per session | a store lock | Stops double-submits and parallel scripts on one session | Keep |
| One running session per reader | a per-reader start lock | Two starts at once can't open two sessions | Keep |
| Interview daily budget | `INTERVIEW_DAILY_BUDGET_USD` ($10) | About 55 typical sessions a day: a beta size | About 1.5x the expected day: 200 sessions x $0.18 x 1.5, so **$55-60** |
| Account-wide breaker | `ASK_DAILY_BUDGET_USD` | Interview spend is added to it too: one Anthropic account, one breaker | Size it for Ask plus the interview |
| Pause | `INTERVIEW_ENABLED`, `scripts/interview-switch.mjs off` | Runtime, no redeploy; Ask's switch also stops interviews | |
| Sign-in and consent | always | No anonymous sessions | Email confirmation already gates sign-in in production |

Together these bound one reader: at most 3 sessions a month, each at most its dollar cap plus
three feedback attempts, about **$2.10** a session and **$6.30** a month however the replies end,
so one reader can't use up the shared daily interview budget.

The daily budgets use the gateway's estimates from each response's `usage` (and a conservative
estimate for calls cut off before usage arrived), so they track the bill closely but are not the
bill: keep the production Anthropic workspace's own spend limit as the backstop.

## The whiteboard (phase 2b)

The board adds little: its text rides in the newest turn (about 230 tokens for a whole board of a
dozen boxes, about 40 for a delta), and its two model fallbacks run on the evaluator's model
(Haiku 5.5), capped per stage.

| | Each | Cap | A six-stage session at the caps |
|---|---|---|---|
| Board text in the turns (cache write) | 40-230 tokens | every reply | about 2k tokens: **$0.005** |
| Label matcher call | 1.2k in, 100 out | `INTERVIEW_BOARD_MATCH_CALLS` (4) a stage | 24 calls: **$0.005** |
| Vision description | one 1024 px image (about 1k tokens), 100 out | `INTERVIEW_BOARD_VISION_CALLS` (2) a stage | 12 calls: **$0.003** |
| Grader images (Opus 5) | about 1.1k tokens an image | 8 PNGs a session | **$0.044** |
| Grader board snapshots | 230 tokens a stage | 12 | **$0.014** |
| **Added to a session** | | | **about $0.01 typical, $0.07 at the caps** |

The PNGs are the room's (the server has no renderer), at most 200 KB each; the gateway's estimate
for a cut-off call does not count image tokens, so a grader call that times out is under-charged by
up to the images' $0.044.

## Voice (phase 3)

A voice session adds speech on top of the tokens, at the vendors' list prices (2026-10): Deepgram
Nova-3 streaming at **$0.0077 a minute** (`VOICE_STT_USD_PER_MIN`), Cartesia Sonic at about
**$0.03 per 1,000 characters** (`VOICE_TTS_USD_PER_1K_CHARS`; the scale plan's rate, to re-check
against the invoice), Daily at **$0.004 a participant-minute** (two participants: not charged per
session by the web, counted here). The pipeline reports audio seconds and spoken characters in its
heartbeats, and the web charges them into the session's cost and the daily budgets, so the dollar
cap and the breaker cover tokens and speech together.

| | A 45-minute voice session |
|---|---|
| Speech-to-text: the candidate's microphone streams the whole session, 45 min | **$0.35** |
| Text-to-speech: about 40 replies of 220 characters, plus openers and nudges, about 10k characters | **$0.30** |
| Daily: 2 participants x 45 min | **$0.36** (on the vendor's bill, not the session's cost) |
| Tokens: 40 exchanges on the text model (replies capped at `INTERVIEW_VOICE_MAX_TOKENS` 350), the evaluator, one grader pass | about **$0.35** |
| **Session** | **about $1.00 charged, $1.35 all in**; the cap `INTERVIEW_VOICE_SESSION_BUDGET_USD` (3) is about 3x |

A Pro reader's five sessions a month are therefore about **$7** all in, against the plan's price;
`INTERVIEW_VOICE_MONTHLY_MINUTES` (225) stops a reader restarting sessions past that. The daily
voice budget `INTERVIEW_VOICE_DAILY_BUDGET_USD` (30) is about 30 sessions a day for the beta, and
counts inside the interview day and the Ask breaker. The voice service itself is one Fargate task
(1 vCPU / 2 GB, about $30 a month on Spot on staging) for up to `VOICE_MAX_SESSIONS_PER_TASK` (4)
concurrent sessions; size that from the staging load test before raising it.

## Coach mode

A coach lesson ([coach-mode.md](coach-mode.md)) runs on the same pipeline and prices as a voice
session; what changes is who talks. The settings that came out of this column: a lesson's cap is
`INTERVIEW_COACH_SESSION_BUDGET_USD` (4, text or voice), its allowance `INTERVIEW_COACH_MONTHLY_SESSIONS`
(10), and its turns run on `INTERVIEW_COACH_MODEL` (the interviewer's model unless set) with
`INTERVIEW_COACH_MAX_TOKENS` (500). The figures below are still estimates; re-measure them with the
cost report once lessons have run. The coach speaks for most of the lesson, so text-to-speech
becomes the largest line, and it makes more model calls (continues as well as answers), each a
little longer than an interviewer's reply. Estimates at the list prices above, not measured.

| Input | Value | Why |
|---|---|---|
| Coach speaking time | about **29 of 45 minutes**, 140 words a minute: about **23k characters** | assumption: the coach explains, the learner asks and answers |
| Coach replies | about **60** (continues and answers), about 160 tokens of text each plus low-effort thinking | assumption: one every 40-50 seconds |
| Transcript per exchange | about **350 tokens** (a longer reply, the draw operations, the learner's words) | assumption |
| Lesson text | the section's rendered text rides in its marker, as the stage notes do; the system block does not grow | design |
| End summary | one Opus 5 pass over the transcript, as the grader | design |
| Drawing through the `draw` tool (`INTERVIEW_COACH_DRAW_TOOLS`, off) | one more call on the cached prefix per drawing turn: about 15 of the 60 replies, so about 15 x 14k cache-read tokens (about $0.06 at Sonnet 5 prices) and a few hundred output tokens | design; the element path makes one call |

| | Voice interview (above) | Coach lesson, Sonnet 5 turns | Coach lesson, Haiku 5.5 turns |
|---|---|---|---|
| Speech-to-text, the microphone open 45 min | $0.35 | $0.35 | $0.35 |
| Text-to-speech | $0.30 (10k characters) | **$0.70** (23k) | $0.70 |
| Turn tokens: cache reads, writes, output | $0.33 | **$0.40** (860k reads, 21k writes, 18k out) | $0.02 |
| Evaluator (Haiku 5.5) and the end summary (Opus 5) | $0.02 | $0.17 | $0.17 |
| **Charged to the session** | **$1.00** | **about $1.60** | **about $1.25** |
| Daily, 2 participants x 45 min (the vendor's bill) | $0.36 | $0.36 | $0.36 |
| **All in** | **$1.35** | **about $2.00** | **about $1.60** |

A typed lesson (no speech) is about **$0.55** on Sonnet 5 and **$0.20** on Haiku 5.5. Drawing adds
almost nothing: the draw operations are a few dozen output tokens a reply, and the board text in
the turns is the same as the interview's.

The heavy case, the coach talking 80% of the time (28k characters, $0.85) and 90 exchanges on
Sonnet 5 at the cap (about $1.00 of tokens), comes to about **$2.60 charged**: inside the voice
cap `INTERVIEW_VOICE_SESSION_BUDGET_USD` (3) but with little room, so a coach cap of about **$4**
keeps the interview's 1.5x headroom. Haiku 5.5 on the continues with Sonnet 5 for answering doubts
(the coach lane's model per move) lands between the two columns, about **$1.35 charged**, with the
better model where the learner's question needs it. Five lessons a month are therefore about
**$8-10** all in a reader on Sonnet, **$8** on Haiku, against a Pro plan's price; whether lessons
share the voice minutes or get their own allowance is an open question in the proposal.

## Re-measuring

`REDIS_URL=... npm run interview:cost -- --days 14` (web/scripts/interview-cost-report.ts) reads
every session from the store and prints sessions and spend by start day and mode, the finished
sessions' mean, p95 and maximum against the model's figures above (`--model-text 0.35
--model-voice 1.00`, `--tolerance 0.2`), and the early-access gate: every mode with five or more
finished sessions within 20% of its model. Compare the spend keys the switch script shows
(`interview-switch.mjs status`) with the vendors' invoices for the same days before trusting the
per-session prices.

Every interview call writes the gateway's usage line (`event: "ask_call"`, `lane: "interview"` or
`"interview-feedback"`, with `session`, `costUsd`, token counts and the cache-read ratio), and each
session keeps its running `costUsd`. After the first beta week:

1. Sum `costUsd` per `session` from the logs: the median replaces "typical", the 99th percentile
   replaces "heavy".
2. Check the cache-read ratio on `lane: "interview"` is above 0.8 after the first turn of a session;
   if not, something before the breakpoint varies per request.
3. Re-derive the daily budget and the session cap from the table above.
