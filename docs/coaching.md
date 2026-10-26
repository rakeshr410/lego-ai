# Coaching material

The coach (coach-mode.md) can teach any section of the site on the fly: it reads the article's
text and diagrams and decides what to say and draw as it goes. That works, but it is different
every time, and its drawings are only as good as its improvisation. The coaching material is the
reviewed alternative: for each section, a **pack** that says what to teach, in what order, how to
check it, what to draw and where; and **playlists** that put packs in a teaching order, so a learner
can go from the box model to a whole news feed, one lesson at a time, on one growing whiteboard.

Claude drafts packs; people review them in pull requests. Every pack is stamped with the hash of
the article section it was written from, so an edit to the article marks the pack stale. A stale
pack, or a section without one, falls back to today's on-the-fly material, so a lesson never
teaches something the article no longer says.

## Files

```
app/coaching/
  packs/<system>/<topic>/<sectionKey>.yaml           one pack per article section
  packs/backend/<system>/<topic>/<sectionKey>.yaml   the same, for a backend article
  playlists/<slug>.yaml                              lessons in order, each a few parts of one or two packs
app/articles/<system>/<topic>.yaml                   lego-ai's own articles (below)
app/articles/backend/<system>/<topic>.yaml           lego-ai's own backend articles
```

Backend design articles and their packs live under `backend/`, apart from the frontend ones, because one
system can have both (Twitter's feed client and Twitter's timeline service): a backend article may share
its system and slug with a frontend article, or with a topic of the main site. The snapshot keeps them in
`backendTopics`, read only by the coach; a backend pack's id starts with `backend/`
(`backend/url-shortener/short-links-end-to-end/api`), and `packRef` (schema.ts) and `topicAt`
(content-snapshot.ts) resolve it. `backend` is therefore not a system slug. How a backend lesson's sections
and board are decided is coaching-backend.md.

### lego-ai's own articles

Most packs are written from the main site's articles (lego's `content/`). A lesson that needs an
article the site does not have gets one in `app/articles/`, in the site's topic format, under one of
the site's systems. The content snapshot adds them to the site's topics (`readOwnArticles` in
`content-snapshot.node.ts`), so a pack is stamped and checked against them like any other; the main
site does not list or serve them, and they stay out of the systems' interview plans and drills.
`node scripts/coaching.ts articles` validates and lints them as the site's linter would, and rebuilds
the snapshot.

The schema is `app/src/lib/server/coaching/schema.ts`; the cross-checks (ids, references, drawing
order, labels, chains) are `catalog.ts`. Both run in `npm test`, in the build, and in
`npm run coaching check`.

## A pack

```yaml
id: formatting-contexts-and-css-positioning/box-model-and-normal-flow/key-idea   # its path
title: Four rectangles per element
source: { hash: 3f2a9c0d1b4e }       # node scripts/coaching.ts hash <id>
review: { status: draft, provenance: ai-drafted, author: claude }
context:
  after: null                         # the pack this one continues (its board too)
  assumes: []                         # ideas taught earlier: refer to them, don't reteach
  carries: [...]                      # ideas this pack establishes for later ones
  terms: [{ term: content box, means: ... }]
board:
  keep: []                            # ids from earlier packs that stay on the board
  elements: [...]                     # regions, boxes, ovals, diamonds, notes, placed on a grid
  arrows: [...]
beats: [...]                          # what to teach, in order
task: { prompt: ..., expects: [1, 3] } # optional: what the learner draws at the end
```

### Beats

A beat is one idea, taught in two or three sentences and checked with one question. It becomes
one of the lesson's items: the room's progress rail shows its `point`, the coach is told how to
teach it, and the evaluator listens for it in the learner's answers.

| Field | What it is |
|---|---|
| `point` | What the learner should come away with, in one sentence. The learner sees it. |
| `kind`, `weight` | As an interview item's. Core beats are checked; supporting ones are taught when there is time. |
| `teach` | How to teach it: the explanation, the example, the order. Notes for the coach, who says it in its own words. One to five lines. |
| `draw` | The board ids this beat puts up, in order. The coach places them as it speaks. |
| `check`, `answer` | The question that checks it, and what a right answer contains. |
| `misconceptions` | Wrong ideas a learner may voice, each with its correction: `"position: relative removes the box from flow -> it stays in flow; only its painted position moves"`. |

Write beats from the section, never beyond it: every claim must be something the section says or
directly implies. Use the article's running example (Slatework, Pathnook, Logscope...) when it
has one; it makes the board concrete. Write in your own words; nothing is copied from any source.

YAML: quote any line that contains `: ` (a colon and a space) or starts with a backquote, `[`,
`{`, `*`, `&`, `!` or `-`, or it parses as something other than text. Quote `source.hash` too: a
hash of digits only would read as a number (`stamp` writes it quoted).

### The board

Every element has an `id` (kebab-case, unique on the lesson's board), a `kind`, a `label`, and a
place on a grid of 20-pixel cells: `at: [col, row]` is its top-left corner, `size: [w, h]` its
extent (a box defaults to 8 × 3; a region must say). The grid is 120 columns by 80 rows.

- **region**: a labelled panel that other elements sit in: "DOM tree", "Render tree",
  "Main thread", "Viewport". Its label is drawn at its top, so leave the first two rows free. An
  element inside it says `in: <region id>` and is placed inside its rectangle.
- **box**: a labelled shape: a node, a component, a step. **oval**: a store or a cache.
  **diamond**: a decision.
- **note**: free text: a number, a rule, a formula (`354 = 320 + 2×16 + 2×1`).
- **arrows** join elements by id, with a few words (`generates`, `reads`, `on scroll`), dashed for
  what is optional or later, `both` for a two-way exchange.
- `dashed: true` on a region or a box draws its edge dashed: a boundary that is not a visible line
  (a margin, a viewport frame over a list, an area).

Tones mean the same thing across a playlist: **blue** structure (elements, boxes, components),
**green** the fast or cheap path (compositor, cache hit, reused node), **red** the costly path or
the problem (layout, a long task, a blank flash), **amber** data and state (stores, payloads,
caches), **grey** background (what is kept from earlier, what is out of scope), **neutral** the
rest.

Plan the board as a picture a teacher would draw on a wall: two to four regions side by side,
reading left to right or top to bottom, boxes inside them aligned on a few columns, nothing
overlapping, room left for what the next pack adds. Labels name what they show (`article.card`,
`Block box`, `Main thread`); a lesson's labels are unique, so the coach and the learner can point
at anything by name. Each beat draws only what it talks about; an arrow is drawn after both its
ends; an element after its region. A beat with no `draw` list is said and not written: in a lesson
the coach draws only what the pack plans.

A section's frame is drawn when that section begins, by the first beat of its pack, never up front
as an agenda, and the coach never talks about the layout: the learner picks it up from the board, which fills in the order it was taught.
Requirements, targets and other facts are numbered notes ("1. newest first, author, text,
images, counts") under a heading note, plain text rather than boxes, which would read as
components.

A design lesson's title is a note on row 0, centred over the board, which starts three rows lower; the room's
view keeps a drawing centred across and starting at the top (geometry.ts `viewFor`), so the title sits just under
the toolbar. Labels carry no timings ("Mock-up", not "Mock-up, minutes 2 to 6") and no people's names: an
example user is "user 1", "user 2". The pen writes a label and the voice reads it; the coach then says what that
part does or holds before it draws the next one.

A lesson's packs share one board: the second part draws beside what the first part left, so a
lesson's packs are planned together, each in its own area of the grid. The catalog checks every
lesson's board as one picture: everything on the grid, every element inside the region it names
(below the region's label), and no two shapes partly over each other (a note is measured by its
text, about 0.45 of a cell per character). It also checks that the picture reads:

- a region runs at most 4 rows below and 6 cells beside what it holds, and is at most 70 cells
  wide (wider, and the view shrinks it past reading size);
- a box's label fits it (labels are written at 20px, about 0.55 of a cell per character, wrapped
  word by word);
- an arrow runs straight from box to box (level when the two share a row band, plumb when they
  share a column) without crossing another box, with room for its words and some line at both ends.
  The room routes any other arrow around the boxes, which reads worse.

Every label is read aloud as the pen writes it, so write labels for the ear: no `#`, brackets or
one-letter tags; `list (ul), 200 items` rather than `ul#list, 200 li`.

Data and endpoints are the exception, written as code an interviewer would write. A client store
or a response is JSON, one note per line on consecutive rows, indented by column, growing a key
per beat (`{ tweets: {`, `t1: { text, time, replies, retweets, likes,`, ...); an endpoint is its request
(`GET /api/tweets?limit=10&cursor=c1`), not a box. The voice reads keys and items with a pause
at each comma and colon and says paths as words ("GET api tweets with limit 10 and cursor c1";
`speakable` in voice/bot/conductor.py). Labels are unique on a lesson's board, so a closing brace
goes on the last line of its block rather than a line of its own. Derive the state from the
components (what each one reads) before normalizing it, and give storage and live updates
sections, and board areas, of their own.

Leave the plan's spots to the plan. What the coach draws of its own, to answer a doubt, goes in the
side notes, a lane to the right of the lesson's rightmost element (coaching/aside.ts); a pack need not
keep room for it.

A list the learner can give first is a numbered list (`board.lists`): its region, its first
line's cell, the rows between lines (`step`), how many lines it holds (`slots`, room for the
learner's own points beyond the plan's) and its width, and the notes that are its plan lines.
Those notes sit on its slots in order and carry no number; the board numbers lines as they are
written. An `ask` names the list, the beats that write it (every line must be drawn by one of
them), the question the coach asks, and up to three hints for a pause. Don't refer to a line by
its number in a beat's teaching: the learner's lines come first.

An ask may instead name plan elements (`ids`, without a list): boxes, regions or lines of JSON
the learner can name, drawn by its beats. Each one they name is placed where the plan puts it,
in the learner's colour. `frame` names what goes up before the question; by default it is the
asked beats' regions that are not among the ids. A beat is in one ask at most.

### Context

`after` chains packs: inside a lesson, each pack continues the one before, and its board starts
where the previous one ended. `keep` names the earlier elements that stay in view; a lesson opened
on its own draws them first. A kept frame keeps some of what was in it (the check rejects an empty one), and up to
120 ids may be kept, so a design taught over several lessons opens each on the whole board so far. `assumes` lists what the learner already has from earlier packs (the
coach refers to it in a sentence instead of teaching it again), `carries` what this pack hands on,
and `terms` the words used with one meaning throughout ("containing block", "reflow").

## A playlist

```yaml
slug: frontend-foundations          # /coach/frontend-foundations; never a system's slug
title: ...
summary: ...
outline: ...                        # where the order comes from
lessons:
  - slug: box-model
    title: The box model and normal flow
    summary: ...
    parts:
      - { title: Four rectangles per element, minutes: 6, packs: [<pack id>] }
      - { title: How a box gets its size, minutes: 8, packs: [<pack id>] }
```

A lesson is one coach session: its parts are the session's stages, its packs their sections, its
beats the items. Lessons are taken in order, and a lesson's first pack may continue a pack from an
earlier lesson (its `after`), keeping part of that board.

## At runtime

- `/coach/<playlist>` lists the lessons; `/coach/<playlist>/<lesson>` is the lesson's landing page
  and room. They are lego-ai's paths (`app/routes.mjs`, and `AI_PATHS` in lego's infra).
- A lesson is turned into a plan (`coaching/lessons.ts`) the coach director runs unchanged: the
  same moves (teach, draw, check, confirm, reteach, answer, park, recap, draw task), the same voice,
  quota and export.
- The coach is given each part's packs as notes beside the article text (`coaching/notes.ts`), and
  draws with `<place ids="..."/>`, which the server turns into regions and boxes at their places
  (`coaching/layout.ts`, `draw.ts`). A `<place>` written outside `<draw>` is read as a drawing too,
  never spoken.
- On a move that draws, the coach is told the move's planned ids. Whatever it leaves out is placed
  for it after the reply (`fillPlanned`), so a move meant to draw never leaves the board empty.
- The coach's earlier replies come back to it with their drawing in place (`Turn.meta.said`,
  `readBack`), ids placed for it included. Without this it reads its own turns as plain words and
  stops drawing after the first move or two.
- Questions are moves of their own: a check (or the question that closes a reteach, or a draw
  task) asks; every other move's questions are dropped as it streams (`questionFilter`,
  `dropQuestions` in `coach.ts`), drawings kept. The voice's pause before the next move
  (`COACH_CONTINUE_AFTER_SECS`) comes between the explanation and the question. A check turns to
  the learner first, by the name they gave on the start card (`Session.learnerName`), alternating
  "So Rakesh, tell me," and "So tell me, Rakesh,"; without a name, "So tell me,".
- In a lesson, a nod ("okay", "mhmm", "sure", "go on") is a continue, not a remark (`isNod`):
  only "move on" or "skip" leaves a section.
- A pack is used when its section's hash still matches and, in a reviewed-only build, when it is
  reviewed. Otherwise that section is taught from the article, as a coach lesson on a system is.

## The learner's thread

After every move of a lesson, the learner's standing in it is recorded for the playlist
(`coaching/progress.ts`): finished or not, the points that held, the ones that stayed shaky, the
questions the coach parked. The next lesson starts with a short summary of the earlier ones, and
the coach builds on what held and revisits what did not, in a sentence, when it comes up. The
record is kept as long as the sessions, exported with the account and deleted with it (privacy.md).

## Drafting and review

```sh
npm run coaching check                     # every file, every reference, every pack against its section
npm run coaching -- hash <pack id>         # the section's current hash
npm run coaching -- draft <pack id> [--after <pack id>] [--keep id,id]   # Claude drafts a pack
npm run coaching -- stamp <pack id>        # after rereading the section, restamp the pack
```

A reviewer checks, against the article section:

1. Every beat is true and is what the section teaches; nothing contradicts it or goes beyond it.
2. The beats are in a teaching order: each builds on the ones before, and the checks can be
   answered from what was taught.
3. The misconceptions are real ones, and their corrections are right.
4. The board reads as one picture: regions and boxes aligned, nothing overlapping, labels short
   and unique, tones used for their meaning.
5. The context is honest: `assumes` lists only what earlier packs teach.

Then sets `review.status: reviewed`, `reviewer` and `reviewedAt`.
