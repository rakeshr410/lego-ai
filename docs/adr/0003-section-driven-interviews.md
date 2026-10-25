# ADR 0003: Interviews are driven by sections, and derived from the topics

- **Status:** Accepted, 2026-10-22
- **Amends:** [ADR 0002](0002-interview-per-system.md) (points 2 and 4); supersedes the
  "Target architecture: a separate interview service" section of the interview README as it stood
  before this date
- **Design:** [docs/interview/README.md](../interview/README.md); the brainstorm that led here is
  the "AI interviewer" design note (Arrowbox, 22 October 2026)
- **Code:** `content-kit/src/interview-derive.ts`, the `derive` command of the content CLI, lint
  rules `derived-plan` and `derived-plan-sanity`

## Context

ADR 0002 made the system the unit of an interview and its plan a hand-written file,
`content/interviews/<system>.yaml`. One plan exists (instagram). The catalogue has 315 systems and
over a thousand topics across the backend, frontend, agentic, database, ML, genai and data tracks,
and the ask is an interviewer that can run an interview on **any topic in any track**: talk through
the parts of the article (functional requirements, the request flow, state, failures, escalation),
drill into one or move on, judge the answers section by section, and read a whiteboard. Hand-written
plans cannot scale to that, and a plan with four stages cannot say which *section* of the article a
weak answer belongs to, which is what the feedback has to report.

The articles already carry most of a rubric. A design article (`customer-support-agent`) is twelve
numbered `sd.section` blocks with checklists, requirement tables, component and sequence diagrams,
choice lists, state machines and tables, each section with an `intro` and a `summary`, plus a
`tutorBrief` that names the sections and, for an agentic topic, `tools[]` with approval rules and
error behaviours. A concept article (`ann-indexes`, `batch-vs-streaming`) is four sections, "The
idea", "How it works", "In practice", "Trade-offs", mostly prose.

The README's target architecture (a separate interview service with its own Postgres schema,
retention job and sticky WebSocket routing) was written for a text-chat product that would grow a
canvas and audio inside the same service. The voice design settled on a different split: the web
tier keeps every durable fact and renders every prompt, and the audio loop is an ephemeral Python
pipeline that can be rebuilt from the session's turns on any task.

## Decision

1. **The section is the unit of coverage, evidence and feedback.** A stage is an ordered group of
   one or two adjacent sections of the same kind with a time budget; it carries `sections[]` and
   the **coverage items** of those sections, each item `{id: <topic>/<sectionKey>/<n>, section,
   kind, weight: core | supporting, text, probe?, wrongSignals?, drawable?, source}`. The evaluator
   tags evidence against items; the report rates sections. The system stays the default scope and
   URL (`/systems/<system>/interview`, 45 minutes); a **topic** (about 13 minutes) and a **section**
   (about 7 minutes) are drills of the same derived plan, not a second product. This reverses
   ADR 0002 point 4.
2. **Plans are derived from the topics, deterministically, in the content kit.**
   `derivePlans()` walks a system's `sd.section` blocks and mines what is typed: checklist entries
   (requirements; functional and numeric ones core), requirement-table rows (metrics), component
   diagrams (one collapsed "names the parts" item and one "explains the flow" item, nodes as
   drawable supporting items), sequence diagrams (one flow item per numbered note, or one for the
   diagram), choice lists and decisions (the chosen option with the others as wrong signals and the
   first con as the flip condition), tables whose columns say choice / why / when we would change,
   state-machine transitions (core when they name an actor), failure modes, estimates, deep dives,
   database access patterns, eval metrics, rubric picks; the section's `summary` sentences (core when
   they carry a number or a hard rule word), its first `intro` sentences (supporting), the
   `tutorBrief` sentences keyed to a section ("Section 7: …" or naming its title), an agentic
   topic's `tools[]` approval rules and `errors[].agentBehaviour` (core safety rules, one copy per
   system), the rows of an interview-order table that name a section, and the answers of a
   "How it's asked" section (each with its question as the probe). Clarifying `qa-reveal` items,
   glossary tables, out-of-scope lists and metric rows become `pmFacts`, what the interviewer
   answers from. Quizzes, labs, code, figures and screens are ignored. Free prose is **not** mined
   here: a committed extraction pass (`content:derive`, writing `content/_derived/`) is a later
   slice, so a prose-only section derives few items and the sanity lint says so.
3. **Stage kind by title first, blocks second, `deep-dive` by default.** A per-profile title table
   classifies a section: for a design article, requirements (problem, scope, requirements,
   estimation), wrap-up (trade-offs, summary, choices), data-api (state, data model, schema,
   interface, API, tools, integration, authorization, contracts, events), high-level (request flow,
   architecture, overview, pipeline, components), deep-dive (failures, evaluation, scaling,
   correctness, queries, evolution, cost, serving, "how it's asked"); the first section of the
   arc is requirements. Blocks only break ties for kinds not yet seen, so a sequence diagram inside
   "Failures" stays deep-dive. A topic whose sections are "The idea", "How it works", "In practice",
   "Trade-offs" gets the **concept profile**: the four sections are four stages (requirements,
   high-level, deep-dive, wrap-up) with their own openers, and a system made only of concept
   articles has **no system interview**, only topic drills.
4. **Stages, minutes, caps.** Adjacent sections of the same kind merge, at most two per stage
   (concept sections never merge). Minutes follow what there is to cover: capped core items plus a
   fifth of the supporting ones, proportional to the scope's budget (42 stage minutes plus 3 of
   feedback for a system; 12 plus 1 for a topic; 6 plus 1 for a section), with a floor per kind in
   system scope (requirements 5, high-level 6, others 4). At most **five core items per stage**,
   chosen by source and kind (plan signal, decision, tool rule, failure, requirement, summary,
   brief, table, mechanism, metric, component and flow, rule); the rest become supporting, and a
   stage with no core item promotes its best three supporting items so there is always something
   to grade. Stage keys are `s<n>-<firstSectionKey>` (stable while the first section keeps its
   key). Any stage with three or more drawable items gets a draw task.
5. **Which topics make the system interview.** Topics whose numbered sections continue across
   files (the customer-support-agent's three chapters, "1." to "11.") are one article and one
   interview. A system of independent topics (instagram, url-shortener, netflix) takes its **lead
   topic**: the design article with the most sections, a requirements section first, core group
   preferred. Every topic with content is also a drill.
6. **A hand-written plan stays primary where it exists, matched by sections.** `interviewStage`
   gains an optional `sections[]` (section keys, bare or `<topic>/<key>`). A stage that names
   sections replaces the matching derived stage's title, kind, minutes, goal, opener, brief,
   follow-ups, signals, red flags and dimensions, and its `signals` become that stage's core items
   (derived items are demoted to supporting). A plan whose stages name no sections is used
   **whole** in system scope, exactly as before this ADR; it never touches a drill. The plan's
   title, summary, prompt, dimensions and grader brief always win.
7. **Publishing and versioning follow the topics.** A derived plan is `reviewed` only when every
   source topic is; `plans.ts`'s `published()` rule applies unchanged, so a reviewed-only build
   serves a derived plan only from reviewed topics. There is no separate approval of a derived plan
   (owner decision, 2026-10-22). Its version is the hash of its source topics, recorded on sessions
   as `planVersion` is today.
8. **The web tier owns the session; the interview service of the old target architecture is not
   built.** Sessions, turns, feedback, consent, quotas, budgets, the board store, the evidence
   ledger and prompt rendering stay in `web/src/lib/server/interview/*` and Redis. No interview
   Postgres schema, no retention job of its own, no sticky WebSocket routing. The voice phase adds
   an ephemeral Pipecat service that holds no prompt text and syncs through an internal API under a
   fenced lease (`Session.voice = {epoch, seq}`); the README describes it.
9. **Voice quota rule (owner decision, 2026-10-22).** Voice interviews are **Pro only**: five
   45-minute sessions a month (`INTERVIEW_VOICE_MONTHLY_SESSIONS`), counted at start, minutes
   reserved from `INTERVIEW_VOICE_MONTHLY_MINUTES` (225) and trued up from usage ticks, plus
   purchased top-up sessions consumed after the monthly five. Free readers keep the text interview.
   Realistic mode only: the interviewer never states the correct idea inside a session; the
   feedback does. English only, Indian English voice; desktop only for the voice beta; raw audio is
   kept seven days only on the candidate's opt-in.

## Consequences

- Every system with a design article has an interview today without an author writing a plan:
  132 system plans and a drill for every one of the 1,033 topics derive from the current content,
  with no derivation error and 33 lint warnings for prose-only stages. `npm run content:derive --
  <system>` prints a plan; `--items` prints every item with its source; `--json` prints what the
  web tier reads. The customer-support-agent plan is six stages, 30 core items.
- Content authors improve the interview by improving the article: a `summary:` line on a section,
  a checklist, a decision block. The sanity lint names the section that has nothing to grade. The
  prose extraction pass, when it lands, fills the rest from committed files, never from the build.
- The stage schema's 2-8 stages and 2-30 minutes no longer bound a plan; the derived schema allows
  1-12 stages and 2-60 minutes. The room, the director and the grader read `sections[]` and
  `items[]` from the plan; a hand-written plan used whole has empty `sections` and one core item
  per signal, so one code path serves both.
- Instagram keeps its hand-written plan unchanged. A system that wants a better system interview
  than its lead topic writes a plan with `sections[]` on the stages it wants to shape, not a whole
  new one.
- The web tier grows the director, the evidence ledger and the item-verdict grader in place of the
  separate service; extraction later means moving a directory, as the prototype note always said.
- Concept-track systems (ML, genai, data) get drills only until a system-level design article
  exists for them; the landing card lists their topics as drills.
