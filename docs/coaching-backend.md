# Backend interview lessons

The frontend interview lessons (Twitter's feed, `app/articles/twitter/news-feed-end-to-end.yaml`) follow
the frontend order: mock-up, requirements, components, state, API, performance. A backend interview is
decided differently, and its lessons follow the backend order instead of borrowing the frontend's. This
note records that order and the board it draws, as extracted from a backend walkthrough video
(InterviewWithBunny, System Design 1: Design Tiny URL, youtube.com/watch?v=Y-BO_4XNw8c), and how the URL
shortener lessons (`app/articles/url-shortener/short-links-end-to-end.yaml`, the `backend-interviews`
playlist) carry it. coaching.md's pack format and checks apply unchanged.

## Sections, as the video decides them

The video's chapters are the article's sections, one pack each:

| Section key | Video chapter | What is said |
|---|---|---|
| `problem-statement` | Understanding the problem statement | What the product does, one example, the one-to-one mapping; the five steps said once (said, not drawn). |
| `requirements` | Gathering functional / non-functional requirements | Functional first, core then optional; non-functional with a number and where it applies (latency, scale, uniqueness, CAP). Inside 10 to 15 minutes. |
| `entities` | Entity creation | The nouns the system keeps. |
| `api` | API creation | One endpoint per functional requirement, written as a request and what it returns. |
| `high-level-design` | High level design | The fewest boxes that meet the functional requirements, the flows as arrows, the tables beside the database. |
| `lld-<approach>` | Low level design, one numbered approach each | The high-level picture opened and grown; each approach is built, measured against a non-functional line, and its flaw written beside it before the next one fixes it. |

The low-level design is one chapter in the video but several numbered approaches on its board
("1. Encryption logic", "2. Counter", "3. Zookeeper"), so it is one section, and one pack, per approach.
What the video does inside an approach stays inside it: the split into create and redirect servers and
the cache are part of the counter; expiry, custom URLs, 301 or 302 and the database choice close the last
approach, where the video draws them, rather than getting sections of their own.

## The board, as the video draws it

One page read top to bottom, each step numbered when it is reached:

- Row 0: the title. Under it, one line on what the product does and one example (long URL becomes short URL).
- `1. Functional requirements` on the left and `Non-functional requirements` on the right, side by side
  (dashed regions holding numbered lists the learner can give first).
- `2. Identifying entities` under the functional list; `3. API creation` beside it, the POST line with its
  body as code lines (`{ longUrl,` / `customAlias?,` / `expiresAt? }`) and the GET line to its right.
- `4. High-level design`: client box, server box saying only what it does ("generates the short URL"),
  database oval, one two-way arrow for the flows and one to the database, the tables as notes beside the
  database (`url: shortUrl, longUrl,` ...).
- `5. Low-level design: N. <approach>`, a region per approach under the high-level design:
  - the approach as one line of logic, then the example that breaks it, then a small latency sketch
    (server box, database oval, an arrow with its milliseconds, notes for the other steps and the total);
  - an architecture that grows left to right: client, a tall load balancer, a column of servers, then the
    stores (Redis, database) on the right, so every arrow runs level or nearly so;
  - when the video redraws the picture with a change (servers split by traffic, a coordinator added), the
    new picture goes under the old one in the same region, with its own labels (a lesson's labels are
    unique and packs cannot erase);
  - the verdict or flaw as a note beside the drawing it judges ("one Redis, a single point of failure").
- Later lessons keep the title and the non-functional list, so the last beat can read the requirements back
  against the final picture.

Tones as coaching.md: blue for the services the approach changes, amber for stores, green for the cache
(the fast path), grey for coordination and background; ephemeral or optional things dashed.

## Lessons

A lesson is one or two steps: problem and requirements with entities and API; the high-level design with
the first approach; then one lesson per later approach, since each grows its own picture. A low-level pack
may run to eight beats and two pictures; size its part's minutes to match.

## Where the lessons depart from the video

The packs teach what the article says, and the article corrects the video where it is wrong: hashing, not
encryption; a look-up by key, not a scan; and in place of hashing a Snowflake ID down to six characters
(which brings collisions back), ZooKeeper hands out counter ranges that are encoded whole. The drawing
stays the video's: ZooKeeper beside the create servers, with the Snowflake layout as a note.
