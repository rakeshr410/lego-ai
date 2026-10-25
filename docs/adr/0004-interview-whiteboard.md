# ADR 0004: The interview whiteboard is text to the interviewer and evidence only in part

- **Status:** Accepted, 2026-10-23
- **Extends:** [ADR 0003](0003-section-driven-interviews.md) (the derived plan gains a board
  reference; the ledger gains board entries)
- **Design:** [docs/interview/README.md](../interview/README.md), "Whiteboard"; the AI interviewer
  design note (Arrowbox, 22 October 2026), section 7
- **Code:** `web/src/lib/board/serialise.ts`, `web/src/lib/server/interview/board.ts`,
  `board-match.ts`, `content-kit/src/interview-derive.ts` (`boardReference`),
  `web/src/components/sd/InterviewBoard.tsx`

## Context

A system design interview is drawn as much as spoken. The text room (ADR 0003) could only read
words, so a candidate who put the architecture on a board had to describe it again, and the
interviewer could not ask "what goes along that arrow?". Pixels are the wrong input for the
interviewer model on every turn (cost, latency, and nothing to match against), and a free-form
canvas has no notion of the article's components.

## Decision

1. **The candidate draws in Excalidraw; the server reads a graph.** The room posts the scene
   (compacted, at most 400 elements) as it settles; the server serialises it into boxes with labels,
   containers, arrows and loose strokes, with short ids that stay stable across versions, and keeps
   one record per session by compare-and-set. The server, not the room, decides what the
   interviewer sees.
2. **The interviewer reads text, not pictures.** A turn carries the whole board the first time and
   a delta after it, about 230 and 40 tokens, saved on the turn so the prompt is rebuilt byte for
   byte and the cache holds. Pictures go to models twice only: a small vision call describes a
   board that is mostly freehand or unlabelled, and the final grader gets one PNG per stage.
3. **The articles are the reference.** The derived plan carries the system's components once each
   (with `aliases`, `introducedIn` and `reachableOnlyVia` from the topic files) and the diagrams'
   edges. A deterministic matcher compares the board with it; a batched small-model call places the
   labels it cannot, capped per stage. The coverage is private: the interviewer gets questions to
   pick from, never "wrong" or "missing", and the room never gets it at all (`content:check-dist`
   and the service tests hold that line).
4. **A drawing is partial evidence.** A drawable item the board shows gets a `partial` ledger
   entry; only the candidate's words make it covered, so a board alone cannot advance a stage. The
   grader sees the boards at each stage's end beside the transcript and applies the same rule.
5. **The board is never the only way to answer.** The outline edits the same graph from the
   keyboard, and the interviewer is told the candidate may describe the design in words.

## Consequences

- Content authors can annotate components (`aliases`, `introducedIn`, `reachableOnlyVia`); the
  linter checks the references. Systems without component diagrams get an empty reference and the
  board is read without matching.
- The board's cost is small (cost-model.md): text in the turns, two capped Haiku calls a stage,
  up to eight images for the grader.
- The interview page alone carries a CSP that allows a blob worker (Excalidraw's); every other page
  keeps the site's policy. Excalidraw's fonts are self-hosted; its Mermaid import is a stand-in that
  explains itself, so mermaid never ships to a browser; the room loads the editor only in a build
  with the board flag, and the editor and its font subsetter have their own size budgets.
- Deferred: the interviewer drawing on the board (a tool call adding shapes in its own colour); a
  CRDT only if two people ever share a board.
