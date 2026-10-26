# lego-ai

Arrowbox's mock interview and coach, as a service of their own: the interviewer and the coach,
their pages, the room (text, whiteboard and voice), the API, the model calls, and the voice
pipeline. The main site is **lego** (a sibling checkout, `../lego`); this service sits on the same
origin, routed by path, so readers never see two sites.

| Folder | What |
|---|---|
| `app/` | The Astro app (Node adapter, React islands): `/systems/<system>/interview` (the landing, the room, the coach), the coach's playlists at `/coach/<playlist>`, `/api/interview*`, and the internal API for lego and the voice service. Its coaching material is `app/coaching/` ([docs](docs/coaching.md)). |
| `voice/` | The voice service (Python, Pipecat): one pipeline per voice session, speaking for the app's interviewer. Its own [README](voice/README.md). |
| `docs/` | The design: [README](docs/README.md) (the program, plans, rollout, voice), [coach mode](docs/coach-mode.md), [coaching material](docs/coaching.md), [cost model](docs/cost-model.md), [privacy](docs/privacy.md), and ADRs 0002–0005. |

## How it fits with lego

**Paths.** The app serves `/systems/*/interview`, `/coach` and `/coach/*`, `/api/interview`, `/api/interview/*`, its build
files under `/_ai/` and the whiteboard's fonts under `/excalidraw/`; lego serves everything else.
The list is [`app/routes.mjs`](app/routes.mjs), and every router in front of the two follows it:
lego's production load balancer (`lego/infra/lib/app-stack.ts`, `AI_PATHS`), `app/scripts/edge.mjs`
(docker compose and e2e), and the dev server's proxy. Change them together.

**Content.** The interview plans and the topics they draw on stay in lego (`content/interviews/`,
`content/<system>/`), as does the block registry (`content-kit/`). The app reads them at build
time from `../lego` (`CONTENT_DIR` overrides the content folder).

**Who is signed in.** Accounts and sessions are lego's. The app forwards the reader's session
cookie to lego's `GET /api/internal/reader` with `Authorization: Bearer $LEGO_AI_SECRET` and
caches the answer briefly (`app/src/lib/server/session.ts`); lego down means 503, never a guess.
The other way, lego exports and deletes an account's interview sessions (and its coaching progress) through
`GET|DELETE /api/internal/interview/readers/<documentId>` with the same bearer. Both sides hold
the same `LEGO_AI_SECRET` (32+ characters).

**Shared state.** In production the app uses lego's Redis: its sessions and quotas, and the model
gateway's daily budget and kill switch, which lego's Ask shares (`node scripts/ask-switch.mjs off`
in either stops both).

**Copied code.** The site's chrome (header, footer, consent, tokens, i18n), the model gateway,
security headers and logging are copies of lego's web, trimmed to what the app uses. A change to
the site's look or to the gateway in lego needs the same change here. `app/src/styles/tokens.css`
is generated in lego (`design/`); copy it over when lego's changes.

## Development

Node 24, and lego checked out beside this repository with its web and Strapi running
(`../lego/web`: `npm run dev`, port 4321; `../lego/cms`: `npm run develop`, port 1337).

```sh
cd app
cp .env.example .env      # LEGO_AI_SECRET: the value in ../lego/web/.env; ANTHROPIC_API_KEY
npm install
npx astro dev --background   # http://localhost:4322
```

Open the site on **http://localhost:4322**: the app serves the interview's paths and proxies
everything else (sign-in included) to lego's dev server (`WEB_DEV_URL`). An interview link opened
on :4321 redirects here. Cookies ignore the port, so one sign-in covers both. With no `REDIS_URL`
the app keeps its state in memory.

```sh
npm run typecheck   # astro check + tsc
npm test            # vitest
npm run build && npm run check:dist   # no interviewer's notes in the browser bundle
npm run test:e2e    # Playwright: needs lego's web, Strapi and Redis running (playwright.config.ts)
npm run eval:interview   # the interviewer and grader evals (real model calls)
```

The voice service: [voice/README.md](voice/README.md).

## Docker

`docker-compose.yml` runs the app, an edge on **http://localhost:4300** that routes by path the way
production does, and (profile `voice`) the voice service, on lego's compose network. Start lego's
stack first with `LEGO_AI_URL=http://ai:4322` and the shared `LEGO_AI_SECRET` in its `.env`.

```sh
docker build -f app/Dockerfile --build-context lego=../lego --build-arg PUBLIC_ORIGIN=https://arrowbox.example .
docker build -f voice/Dockerfile .
```

## Deploy

lego's CDK runs both services (`lego/infra`, config `ai` and `voice`): the app at `ai.internal:4322`
behind the load balancer's interview paths, the voice service at `voice.internal:7860`. This
repository only builds the images: the **Images** workflow builds `arrowbox-ai:<env>-<sha>` with
lego's build settings for that environment (`lego/infra/scripts/web-build-args.ts <env> <sha> ai`,
so the header and footer match the main site's pages) and `arrowbox-voice:<sha>`, and pushes them
with the push-only role from lego's CI stack (`AiPushRole`, once `CI.aiGithubRepo` names this
repository). Then run lego's **Deploy** workflow with `ai_image_tag` and `voice_image_tag`; without
them a deploy keeps the tags already running.

Repository settings: variables `AWS_PUSH_ROLE_ARN` (lego's ci stack output `AiPushRoleArn`) and
`LEGO_REPOSITORY`; secret `LEGO_CHECKOUT_TOKEN` (read-only access to lego, for CI and images).
