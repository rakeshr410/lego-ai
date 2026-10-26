## Layout

- `app/`: the Astro app (the mock interview and the coach). `voice/`: the Pipecat voice service. `docs/`: design and ADRs.
- The main site is `../lego`. The app reads its `content/` and `content-kit/`; accounts and sessions are lego's (README.md, "How it fits with lego").
- The paths this service owns are `app/routes.mjs`. A new route there also needs `AI_PATHS` in `lego/infra/lib/app-stack.ts`.

## Development

Run lego's web (port 4321) and Strapi first. Then, in `app/`, start the dev server in background mode:

```
astro dev --background
```

Manage it with `astro dev stop`, `astro dev status` and `astro dev logs`. Browse the site on http://localhost:4322, which proxies every other path to lego's web.

Checks: `npm run typecheck` and `npm test` in `app/`. Coaching material (`app/coaching/`, docs/coaching.md): `npm run coaching check` after editing a pack or playlist. In `voice/`: `.venv/bin/ruff check .` and `.venv/bin/python -m pytest -q`.

## Documentation

Astro: https://docs.astro.build
