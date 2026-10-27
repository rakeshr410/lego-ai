# Coach mode: the AI drives the session (proposal)

- **Status:** Proposal, 2026-10-24. Phases 1-3 and 5 shipped and phase 4 decided 2026-10-25 (see "Phases").
- **Builds on:** [README.md](README.md) (the interview program), [ADR 0003](adr/0003-section-driven-interviews.md)
  (the web tier owns the session; plans derive from the sections), [ADR 0004](adr/0004-interview-whiteboard.md)
  (the board is text to the model), [ADR 0005](adr/0005-interview-voice.md) (a Pipecat service owns the audio, only)
- **Earlier work surveyed:** `~/martin` (a Gemini Live voice agent with a turn-taking "floor"), `~/drawing-board`
  (an animated pen over Excalidraw), `~/armoury` (34 model tools, 12 of them board tools)

## What coach mode is

In interview mode the candidate drives and the interviewer asks. In coach mode the AI drives: it takes the
learner through the plan topic by topic, explains each item, draws the system on the board as it goes, asks a
check question, answers the learner's doubts, and keeps to the syllabus. The learner can interrupt at any time,
ask to go back, or ask to move on.

The syllabus already exists. A derived plan (`content-kit/src/interview-derive.ts`) is stages of sections of
items, each item with its kind, probe and wrong signals, `drawable` where it can be drawn, and `tutorBrief`
background; the board reference lists the system's components with the section each is `introducedIn` and the
edges the articles draw; `drawTasks` per stage say what a learner could draw. The same three scopes apply:
a system (45 min), a topic (13) or one section (7). Coach mode adds no content format: a lesson is the plan read
forwards by the coach instead of probed by the interviewer.

## Where the coach's brain lives: three options

| | A. Web tier drives, pipeline unchanged in kind | B. Tools in the Pipecat service | C. Speech-to-speech model (martin's shape) |
|---|---|---|---|
| Who calls the model | The web, as today (`service.ts` `reply()`, one lane per call kind) | The voice service, with function calling | A realtime vendor (Gemini Live) |
| Session state | Redis under the session, leases, quotas, budgets, grading: all reused | Duplicated in Python, or round-tripped per tool call | Rewritten: prompts, director, evaluator, grader are text-first |
| Drawing | Ops in the reply, validated on the web, forwarded to the room | Tool handlers in Python, a Node bridge to the board | The vendor's tool calls |
| Typed coach | Free: the text room gets it first | Voice only | Voice only |
| Fits the ADRs | Yes | Breaks ADR 0005 (no prompt, no store, no model in the service) | Breaks ADR 0005's reasoning (keep one Claude stack) |

**Recommendation: A.** Coach mode is a second director and a second prompt in `web/src/lib/server/interview/`,
with a session `kind`, plus two small, generic additions to the voice service: a streamed "continue" turn and a
channel for board operations to the browser. The Python service learns nothing about coaching; every later mode
is a web-tier change.

## The design

### 1. Session kind, orthogonal to transport

`Session.kind: 'interview' | 'coach'` beside `mode: 'text' | 'voice'` (`sessions.ts`). A coach lesson can be
typed or spoken; the start route takes `kind`. `getPlan(system, scope)` is unchanged. Quota: its own allowance
(`INTERVIEW_COACH_MONTHLY_SESSIONS`, minutes shared with voice) so the owner can price it separately; the
cost model shifts to TTS characters because the coach talks most of the time (cost-model.md needs a coach column).

### 2. A coach director, pure and replayable like `director.ts`

A decision table run per turn and per idle rung, with its own state on the session
(`Session.coach`). It walks `stage.sections` and each section's `stageItems()` in order and keeps a status
per item: `queued | explained | checked | understood | shaky | parked`.
An item is understood only on evidence: an answer the coach confirmed or the evaluator tagged covered, or the
item drawn on the learner's own board. An item taught without a check stays explained, and a check the learner
let pass without a word (a continue, the voice's idle) is shaky; the next move then gives the answer itself
without praising anyone ("the learner gave no answer"). A silent lesson ends with nothing understood.

Moves: `teach(item)` · `draw(item)` · `check(item)` (one question from `item.probe`) · `reteach(item)` (once,
differently, when the evaluator's signal says partial or wrong) · `answer_doubt` (then return to the item) ·
`park(off-syllabus)` (name where it is covered, from `introducedIn` or `readFirst`, and return) · `recap(section)` ·
`advance_section` · `advance_stage` · `end`. Reused as they are: the time policy (`sectionShareMs`, `POLICY`), the
intents (`advance`, `dont_know`, `drill`) plus three new ones (`pause`, `repeat`, `question`), and the evaluator's
ledger: the same item tagging that judges an interview answer judges whether a check question was understood.
Goldens in `web/eval/interview/goldens.ts` get coach transcripts; `interview-eval.ts` replays them.

**Self-drive without a new turn mechanic.** Today nothing advances on silence. In coach mode a short silence
after the coach finishes *is* the cue to go on. The pipeline's `IdleGate` already reports rungs the web chose at
attach (`idle_rungs` in `PipelineView`); a coach session attaches with rungs like `[3, 45, 120]`: the first
means "continue", the later ones "are you still there". The text room gets the same from a **Continue** button
and an auto-continue timer. The learner drawing on the board must hold the coach back: the room sends a client
message (`activity`) that resets the idle timer (martin's gate has this rule: drawing counts as activity).

### 3. The coach prompt

`coachSystem(plan)` beside `interviewerSystem()` in `prompt.ts`, with the same caching shape: the rules, the
stages and the topic briefs in the system block; the section being taught travels in its marker as the stage
notes do today, so the system block does not grow. The lesson text is the sections' own rendering
(`registry.ts` `toText` gives a faithful text of every block, diagrams included), the way Ask's tutor
(`tutor.ts`) is grounded in the whole topic. A `<coach>` element replaces `<director>` on each learner turn and
each continue: the move, the item, what has been explained, the minutes left in the section. Rules that differ
from the interviewer: explain and give answers; one idea per reply; draw as you explain; check, don't grade;
stay inside the syllabus and say so when asked beyond it. The spoken style block stays.

### 4. Drawing: a richer vocabulary on the existing path, then tools if it outgrows it

Today a reply may end with one `<draw>` element of up to four `box`/`arrow` ops, once a stage, parsed by
`draw.ts`, validated against the board record, saved on the turn, applied by the room (`InterviewBoard.draw`).
That path is the right one; it needs widening, not replacing:

- **Vocabulary**, ported from armoury's twelve board tools and drawing-board's shapes: `box` (kind: box, circle,
  diamond; `group`), `arrow` (`label`, `dashed`, `both`), `note` (`text`, `near`), `estimate` (`label: value`,
  `near`), `highlight` (a box or an edge), `rename`, `erase` (own elements only), `clear mine`. Unknown targets
  are dropped with a numbered reason, as drawing-board's `Outcome` does, and the reason goes back to the model
  on the next turn so it can correct itself.
- **Caps per kind**: interview keeps four ops once a stage; coach gets eight ops per reply and many per section,
  `author: 'coach'`, the serialiser already marking authored elements so the matcher never credits them.
- **Inline, not only trailing.** A lesson interleaves words and marks. `holdDraw` is extended to parse
  `<draw>` elements anywhere in the stream and emit each as its own `draw` event, so a box lands as the sentence
  about it is spoken. Reference drawings come from the article: a section's `sd.component-diagram` nodes, groups
  and edges give the coach a canonical picture to draw in the article's own layout, and `drawTasks` give the
  learner something to draw back, checked by the existing matcher.
- **Paced drawing** (later): drawing-board's pen (`src/pen/*`: a promise queue, in-flight batches, an animator
  with `beforeShape/beforeLabel/beforeLine` hooks) is browser TypeScript over Excalidraw 0.18.1, the room's own
  version. Its animator and graph builder can be vendored into `web/src/lib/board/` behind `ExcalidrawCanvas.tsx`
  (the one module allowed to touch the library) within the size budgets. Not before the vocabulary settles.
- **Tools instead of tagged text** only if the ops need the model to wait on a result (a drawn cue, a layout
  conflict). Anthropic tool use would move drawing into `tool_use` blocks on the coach lane; the reply's text
  streaming and the first-clause start would need the tool blocks interleaved. Keep it as an option.

### 5. Pipecat: two generic additions, no mode logic

The service stays "attach, speak what the web streams, report what was heard". Changes in `interview-voice/`:

1. **Streamed continue turns.** `POST …/idle` answers one `say` line today. Coach mode needs an idle rung to
   stream a full reply (the next item). Generalise `/turns` to `{epoch, seq, kind: 'speech' | 'continue', text?}`
   and let `GatewayLLMService` run a continue the way it runs a turn (same lock, same cut-in handling,
   `played` trims a teaching monologue the learner interrupts; the coach director resumes from the trimmed
   words). `IdleGate` fires `continue` on its first rung in a session whose attach state says so.
2. **A board channel to the browser.** The SSE reply gains a `draw` event; the gateway forwards each as
   `rtvi.send_server_message({kind: 'draw', ops})` (`run.py` already sends `state` this way), ideally when the
   preceding sentence's TTS has started so the mark keeps time with the voice. `VoiceCall` (`web/src/lib/voice-call.ts`)
   adds `onServerMessage` (the Pipecat client has it) and the room applies the ops through the board handle. The
   saved turn still carries the ops, so a reload or the typed room replays them, and the room's next board save
   persists the scene as today.
3. **Per-session tunables from the web, not the environment.** `SessionSpec` gains what a coach lesson wants
   different: idle rungs (already), a longer reply token cap on the coach lane (`INTERVIEW_COACH_MAX_TOKENS`),
   and the turn-stop pause for a learner thinking aloud. martin's floor rules worth porting into `TurnShaper`
   or a sibling processor: a "let me think" hold that stretches `turn_stop_secs`, and a short bare "sure/okay"
   that ends a turn at once. The rest (barge-in, echo guard, reply-owed) Pipecat's VAD, smart-turn and the
   gateway's lock already cover.

Scalability is unchanged: the service is stateless per session, the supervisor caps sessions per task,
`/ready` reports capacity, SIGTERM parks and any task rejoins. A coach session costs more TTS characters and
more model tokens per minute, which the heartbeats already charge, so the caps (`INTERVIEW_VOICE_SESSION_BUDGET_USD`,
the daily budgets) need coach values rather than new machinery. CPU per task is VAD and smart-turn, not speech,
so `VOICE_MAX_SESSIONS_PER_TASK` holds.

### 6. The room

The call screen (design 17a) serves both kinds. Coach mode adds: the syllabus rail (sections and items with
their status, replacing the stage bar), **Continue** and **Ask a question** in the text room, a "you draw"
prompt when the coach sets a draw task, and the end screen as "what you understood" (items understood, shaky,
not reached, from the ledger) with a "Try the mock interview" link onto the same plan.

## What carries over from the three repos, and what does not

| Repo | Reuse | Leave |
|---|---|---|
| martin | The floor's rules as thresholds and regexes (thinking hold, compliance hold, mid-sentence hold, "drawing is activity"); `defineAgent`'s shape as the model for a per-kind profile | Gemini Live transport and wire format, Web Audio devices, React bindings, turn end tied to the speaker buffer |
| drawing-board | The element vocabulary and diagram families; the pen's queue, in-flight registry and `landed` wait (vendor into the room later); `Outcome` reasons as numbers | The source-alias packaging; the headless host (the room is live) |
| armoury | The twelve board tools as the `<draw>` vocabulary and their validation rules; the "drawn cue" idea (the room acknowledges applied ops so the transcript records what landed) | Gemini's uppercase schema types; the 19 bench handlers and sub-agent ports (a different product); the Node runtime |

None of the three runs under Python, and none should: the drawing stays in the browser, the words on the web.

## Phases

1. **Text coach (web only).** *Shipped (2026-10-25).* `Session.kind`, the coach director (`coach.ts`, replayed
   as unit tests rather than entries in the goldens file), the coach prompt with the section's article text in
   its lesson notes, the wider `<draw>` vocabulary and caps, Continue and auto-continue in the text room, the
   syllabus rail, the ledger-based end screen. Behind the interview flag; `?kind=coach` on the interview page.
2. **Voice coach.** *Shipped (2026-10-25).* `/turns` takes `kind: "continue"` and streams a `draw` event; the
   pipeline's `GatewayLLMService` runs a continue like a turn (same lock and cut-in handling, no filler) and
   forwards each drawing as an RTVI server message the room's board applies; the attach state carries
   `selfDrive` (1.5 s after a move that waits for nothing, 45 s after an unanswered question), which the idle
   clock fires as a continue in place of the rungs; a cut-off move is trimmed by `played` and the prompt tells
   the coach to pick up where it left off; the web sends a 3 s turn-stop for a lesson; a voice lesson counts
   against the coach quota and the coach budget. Not yet: the vendored pen and inline ops timed to speech (phase 3).
3. **Drawing quality.** *Shipped (2026-10-25).* `<draw>` elements anywhere in a reply (`draw.ts` `drawParser`,
   one parser per reply carrying the board, the reply's own boxes and the cap across elements): the stream sink
   hands each element over as it closes and the service sends it as a `draw` SSE event (the public route and
   the pipeline's `/turns`), so a box lands as its sentence is read or spoken; the saved turn still carries every
   operation, and the room does not draw them a second time. An operation the board cannot take is dropped with
   a numbered reason (`TurnMeta.drawDropped`), rendered as a `<board-note>` before the model's next turn. The
   lesson notes carry each section's `sd.component-diagram` as a `<diagram>` (groups, boxes, arrows with labels,
   in the article's order; `lesson.ts` `sectionDiagrams`) and the prompt tells the coach to draw that picture,
   with `group` keeping a group's boxes together, highlights for a box it returns to and notes for numbers.
   The plan's `drawTasks` run: once a part's items are taught and time allows, the coach sets the task
   (move `draw_task`, row 12; the room shows the prompt and a "Done drawing" button, no auto-continue; the
   voice coach waits 45 s), and the next continue or remark reviews it (move `draw_review`, row 13) from what
   the matcher found on the learner's own boxes (author-marked elements no longer count as evidence anywhere:
   `boardForTurn` matches the learner's graph for the tags) plus the live signal; items drawn turn understood,
   the missing ones the coach may draw itself. The board paces the marks (`web/src/lib/board/pen.ts`: drawing-
   board's promise queue and beats, cut down; one mark a beat, the view scrolled to it, nothing when the tab is
   hidden). Not vendored: drawing-board's cursor animation and the `beforeShape/beforeLabel` speech hooks; the
   voice path times a mark by when its element closes in the stream, not by when the TTS reaches the sentence.
   *After the first live lesson (2026-10-25):* the moves ran long (an intro of two sentences plus a 150-word
   teach, then the next teach on auto-continue) and the requirements never reached the board, because only
   items marked `drawable` (parts of a diagram, flows, tables) set `draw="yes"`. Now every item goes on the
   board once: a part is drawn, anything else (a requirement, a target, a rule, a decision) is written as a
   `<note>` on its own under a heading note, so the board builds the list as the coach teaches (`coach.ts`
   `TEMPLATES.teachWrite`). A teaching move is two or three sentences under 60 words, the intro one sentence,
   a recap one, and `INTERVIEW_COACH_MAX_TOKENS` defaults to 500; the spoken style says three sentences.
4. **Options held open.** *Decided (2026-10-25).*
   - **Tool use for drawing: built, behind `INTERVIEW_COACH_DRAW_TOOLS` (off).** The coach lane offers a `draw`
     tool on every turn (a stable cached prefix; `draw.ts` `DRAW_TOOL`), and the coach prompt swaps the
     `<draw>`-element rules for tool rules (`prompt.ts` `COACH_TOOL_DRAWING`). `coachTurn` runs each call inside
     the turn: the input is rendered as an element body and read by the same parser (`drawToolBody`), the
     operations go to the room at once, and the result tells the model what landed and why the rest was dropped
     (`drawToolResult`), so it can fix a dropped operation in a second call; a call on a move without
     `draw="yes"` is refused in its result. Rounds are capped at two model calls a turn (`COACH_TOOL_ROUNDS`);
     the move's words are the text blocks of every round. What it costs: a second call on the cached prefix per
     drawing turn (cost-model.md). Why it stays off by default: the element path already gives the model the
     dropped reasons on its next turn, lands marks as the words stream, and makes one call; the tool path
     earns its call only where a drawing must be right within the turn (a draw-review correction, a layout the
     article fixes). Turn it on for a cohort and compare the two in the cost report and the eval before
     choosing.
   - **A realtime speech model: not built; a measured decision, as ADR 0005 left it.** The voice service's
     latency line (`interview-voice/bot/latency.py`: speech end, turn end, first token, first audio, per
     exchange) is the evidence. Criteria to switch: the coach's first audio after the learner's last word above
     1.5 s at the median or 3 s at the 90th percentile over a month of lessons, with the model's first token
     the larger leg (the web's `prepMs` and the gateway's time to first text separate it from VAD, smart-turn
     and TTS); or learners rating naturalness below the interview's in the end survey. What it would cost:
     the text-first prompt, director, evaluator and grader rewritten around a vendor's audio session (section
     "Where the coach's brain lives", option C), a second vendor and consent text, and the loss of the typed
     room sharing the coach's code. Until lessons have run live, no number exists; the decision is a human
     gate ("Open questions").
5. **The pen keeps time with the voice.** *Shipped (2026-10-25).* Asked for after the first live lesson: the
   earlier setup (drawing-board over martin's Gemini Live session) drew with an animated pen whose marks kept
   time with the speech, and the room dropped finished shapes timed by the text stream. Three seams, no new
   model or setting:
   - **Anchors on the web.** The stream sink (`draw.ts` `holdDraw`) counts the words it has forwarded and hands
     each `<draw>` element over with `{words}`: how many words of the reply come before it (`DrawAnchor`). The
     service's live draw emitter and the tool path pass it on, and both SSE routes send `draw {ops, anchor}`.
     The typed room ignores the anchor and draws at once.
   - **The hold in the voice service.** `bot/pacer.py` `DrawPacer` holds each drawing until the output transport
     has played that many words (`UsageObserver.spoken_words`, counted from the `TTSTextFrame`s the transport
     pushes at play time: a word at a time with Cartesia's timestamps, a sentence at a time with a voice that
     has none; a word of slack for the counts differing), then sends it to the room over the call. Drawings land
     in order; the reply stopping (its end, or the learner cutting in) lands whatever is held, so the board
     agrees with what the coach believes it drew; a hold past 20 s lands by itself. The observer gained
     `on_spoken` and `on_stopped` hooks; `run.py` wires them.
   - **The pen in the room.** drawing-board's `src/pen/animator.ts` is vendored into `web/src/lib/board/pen/`
     (cut to boxes, labels, arrows, notes, frames; no freehand, walks, hover or camera): a box grows from its
     corner and its label is typed with the pen pulsing the box, an arrow extends, a note is written out, a
     highlight pulses, an erased element is untyped or shrinks, with a cursor over the canvas where the pen is
     (`InterviewBoard.tsx` `PenCursor`; none while the tab is hidden, when the marks land at once). The pen's
     queue keeps the operations in order and builds each one's elements when its turn comes, on the scene as
     it stands then. `ExcalidrawCanvas.tsx` grew `penHost` (the scene, a committed frame recorded or skipped,
     board-to-viewport points, the view brought to the ink) and `buildBox/buildArrow/buildNote` beside the
     `add*` functions the outline uses. The beat queue of phase 3 (`pen.ts`) is gone.
   - **A cut-in is answered, then the lesson goes back.** The voice reports the words heard whenever the learner
     speaks over a reply that is still playing, not only while its text is streaming (`GatewayLLMService`
     `playing`, from `UsageObserver.playing`), before it sends their turn. The next decision gets `cutIn`: a
     teaching move cut short is taken back (its item queued again, not drawn, `resume` set); what the learner
     said is answered and nothing more ("okay so" or "wait" over the coach gives them the floor: "Yes, go
     ahead?", never a nod); and the next move goes back to the item ("Okay, now let's go back to the mock-up"),
     picking up where the voice stopped and drawing what is not on the board. A cut check stands: what is said
     over it is taken as the answer.
     The words heard are matched to the reply word by word (`voice.ts` `heardPart`: the voice reports them without
     the reply's punctuation), and a cut reply is read back to the coach as heard, without the drawings it never
     finished (`meta.said` dropped; `fillPlanned` does not count a cut reply's drawings as placed). The voice
     logs when the learner starts talking and each cut-in (`voice learner speaking`, `voice cut-in`).
   - **The opening board is on at once.** A lesson that continues an earlier one's board (its first pack keeps
     their ids) gets that board as a prelude. The room puts it on at once, without the pen (`instant`: the draw
     message from the voice, the SSE draw's `anchor.prelude`, `DrawOpts.instant`), so the coach's first words
     are not spoken over a long redraw of what the learner has already seen drawn.
   - **A brief before the first drawing.** On a lesson that opens on an earlier lesson's board, the intro move
     says, in two or three sentences, what is being designed, what the parts already on the board show and what
     this lesson adds, and draws nothing until it teaches (`openingBrief` in service.ts).
   - **"id" is said as letters.** The voice's text filter `SayAsLetters` (bot/vendors.py) turns "id", "ids" and
     "authorId" into "ID" for the speech only, so it is not read as a word.
   - **No questions for now.** `INTERVIEW_COACH_QUESTIONS` (off by default) gates everything a lesson asks of the
     learner: the check after an item (row 9, and so the reteach after it) and the draw task at a stage's end
     (row 12). Off, a lesson teaches straight through, and the question filter strips any question the model
     writes into a teaching move. Turn it on when the questions come back.
   - **The learner can turn the questions off.** The room's "Questions" toggle (typed and voice rooms; POST
     `{action: "questions", on}`, kept on the session as `coachQuiet`) makes the lesson teach straight through
     whatever the settings above allow: no check or reteach, no draw task, and no part the learner gives first
     (`input.quiet` in `decideCoach`). What was still asked is settled: an open list closes and its lines are
     taught, a draw task is dropped unreviewed, and the lesson view stops waiting (`waiting: 'continue'`). The
     learner can still speak or ask at any time. Over a call the room passes the new wait to the pipeline
     (`pace`, a client message), which restarts its clock on it. Turned back on, the next move asks as before.
     The choice is remembered in the browser (`lib/coach-pref.ts`): the next lesson starts with it (`{questions: false}`
     on the start), and a resumed lesson keeps its own.
   - **The next move waits for the learner.** The voice's self-drive (1.5 s after the coach falls silent) never
     fires while the learner talks: a cut-in stops the voice without arming it, and when they stop, it waits
     `AFTER_LEARNER_SECS` (3 s) more, and skips the move if a reply is already being made (`IdleGate`,
     `run.py`). Before, the move fired during the learner's cut-in and was spoken before their answer.
   - **A pause after each sentence, sized to it.** A lesson's reply is spoken a sentence at a time, each followed
     by silence so the learner can take it in (`pause_after` in the conductor, `GatewayLLMService._speak`): 800 ms
     after a statement, 1.2 s after a question, and a 450 ms beat after a short setup ending in a colon ("Picture
     this:"; four words or fewer, a longer clause runs on past its colon). The coach writes for the ear
     (`COACH_SPOKEN_STYLE`): varied sentence lengths, setups, the key word last, and questions it answers itself
     at once, which the question filter keeps when more of the reply follows and the question is not put to the
     learner ("So why not an offset? Because ..."); "Does that make sense?" is still dropped.
   - **Nothing drawn twice.** A placed region already on the board (a frame there) or a box whose label wraps
     is not placed again (`drawParser`), so the voice does not read its label again; and a draw task whose
     parts the coach has drawn already is skipped (`decideCoach` row 12), since the learner would be asked to
     draw what is on the board.
   - **Doubts are sketched in the side notes.** A question inside the syllabus (row 5) may draw
     (`aside` on the decision, `draw="aside"` on the coach element): the coach's own boxes, arrows and notes,
     with a heading note naming the question. In a lesson every box or note of the coach's own, on any move,
     goes in a lane 4 cells right of everything the plan can place (`asideFor`, `asidePlacer` in
     coaching/aside.ts), so it never takes a spot a later part needs: each sketch starts under the last one and
     no higher than the part placed last, boxes two to a row with room for an arrow's words, notes on lines of
     their own. An answer places none of the plan (`noPlace`); it points at a part with a highlight.
   - **The learner gives a list first.** A part a pack marks with an `ask` (its requirements, say) is the
     learner's before it is the coach's (`input.asks`, from `INTERVIEW_COACH_ASKS`, on by default, and apart
     from `INTERVIEW_COACH_QUESTIONS`). The coach puts up the part's frame and asks for the list (row 14,
     `ask`); each thing the learner says is written on the list as their own line, tidied, numbered in the
     order written and green (row 15, `capture`: `<note covers="plan line">`, or no `covers` for a point the
     plan lacks); a silence gets one of the pack's hints (row 16, `nudge`). "That's all", or a silence past the
     hints, closes the list: a beat whose lines were all given counts as understood, the others are taught,
     only the lines the learner left out (`place` on the decision), the first of them opening with how many
     the learner named; a learner who named every line is credited (row 17, `credit`). The coach never judges,
     corrects or adds to a point while the learner gives it. A point past the list's room (its slots less the
     plan lines still open) goes to the side notes. These moves wait as a check does (`waiting: 'answer'`), so
     no wait time changed. A part that is drawn rather than listed (the mock-up, components, a JSON shape, the
     options for live updates, performance techniques) is asked for by its plan elements (`ids` on the ask):
     a point the learner makes that matches one places that element where the plan puts it, in the plan's
     words and the learner's green (`<note covers="id">`, drawn by `parts` in draw.ts), so arrows and layout
     still fit; a point the plan lacks goes to the side notes in green. The fill then draws what they left out
     and the beats' other drawing (arrows, notes on why). A lesson may open on an ask (the opening sentence,
     then the question). Parts with nothing to give (the prompt, normalization, cursor versus offset, the
     recap) stay coach-led.
   - **A cut-in stops the pen.** When the learner talks over the coach, the voice drops its queued audio and
     tells the room to `release`: the pen finishes the mark the voice had reached and leaves the rest of the
     drawing undrawn (`VoiceCues` `dropped`), since the voice never said it. The board is saved as drawn, so the
     coach sees those parts as not yet on the board and draws them when it comes back to them.
   - **The pen points while it talks.** Between marks the pen hovers over what the voice is explaining, as
     a hand does: when the coach starts talking it comes to the last thing written, and when its words name
     something on the board (two words of a label in a row, or a whole one-word label: `pen/pointer.ts`, fed by
     the call's `bot-tts-text` words) it moves under that writing and drifts along it (`Pen.hover`). It never
     hovers while a mark is being drawn, stays while the voice goes on and leaves when it stops. A voice that
     times sentences, not words, has its sentence's words heard at about three a second (`HEARD_WORD_MS`).
   - **Not done, and why.** The ink waits for the words, not the words for the ink (drawing-board's walks had the
     speech wait): the coach's reply is one model call read by TTS, so the speech cannot pause for a slow
     drawing; the synced tempo is quick enough that a two-element drawing is on the board before the next
     sentence ends. Word timing is as good as the voice's word timestamps; Sarvam and Smallest give a sentence.
     The delay before the coach starts speaking is unchanged (phase 4's latency criteria still apply).

## Open questions (human decisions)

- Pricing and quota: a coach allowance of its own, or voice minutes shared?
- Consent: the vendors are the same; counsel to confirm the text covers a lesson as it covers an interview.
- Model for the coach lane: Sonnet 5 (as the interviewer) or Haiku 5.5 for continues with Sonnet for doubts?
- How far off the syllabus may a doubt go before the coach parks it?
- Drawing path for the coach lane once lessons have run: elements (default) or the `draw` tool
  (`INTERVIEW_COACH_DRAW_TOOLS`), by the cost report and the eval.
- A realtime speech model: only if the latency line crosses the criteria in "Phases", item 4, after a month of
  live lessons; it would reopen ADR 0005.
