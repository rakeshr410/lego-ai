# syntax=docker/dockerfile:1.10
# lego-ai app: the mock interview and the coach (the Astro Node server and its prerendered pages).
# Built from the lego-ai repository root, with a checkout of lego (the main site) as a named
# context: the build reads lego's content-kit and content/, as it does in development.
#
#   docker build -f app/Dockerfile --build-context lego=../lego \
#     --build-arg PUBLIC_ORIGIN=https://arrowbox.example --build-arg PUBLIC_INTERVIEW_ENABLED=true \
#     -t arrowbox-ai:$(git rev-parse --short HEAD) .
#
# Build the PUBLIC_* settings that shape the site's header and footer with the main site's values
# (app/.env.example). Runtime secrets (LEGO_AI_SECRET, ANTHROPIC_API_KEY, REDIS_URL,
# INTERVIEW_VOICE_SECRET, DAILY_API_KEY, SENTRY_DSN) are read from the environment when the
# container starts and are never baked into the image.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS deps
# The two repositories side by side, as on a developer's machine: app/package.json links
# file:../../lego/content-kit, and the content snapshot reads ../../lego/content.
COPY --from=lego content-kit/package.json content-kit/package-lock.json /src/lego/content-kit/
RUN npm --prefix /src/lego/content-kit ci --no-audit --no-fund
COPY --from=lego content-kit/ /src/lego/content-kit/
# The content graph's client (lego/graph): a build with GRAPH_URL set fetches its material from the graph.
COPY --from=lego graph/src/client.ts /src/lego/graph/src/client.ts
# The page's event bus (lego/events) and the site shell's auth hint (lego/site-shell), which the
# interview and classroom modules share with the page they mount in.
COPY --from=lego events/src/ /src/lego/events/src/
COPY --from=lego site-shell/src/ /src/lego/site-shell/src/
WORKDIR /src/lego-ai/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY --from=lego content/ /src/lego/content/
COPY app/ ./
ARG PUBLIC_ORIGIN
ARG PUBLIC_MEDIA_URL=
ARG PUBLIC_INTERVIEW_ENABLED=false
ARG PUBLIC_INTERVIEW_BOARD_ENABLED=false
ARG PUBLIC_INTERVIEW_VOICE_ENABLED=false
ARG PUBLIC_INTERVIEW_SYSTEMS=
ARG PUBLIC_ASK_ENABLED=false
ARG PUBLIC_LABS_ENABLED=false
ARG PUBLIC_AGENT_LABS_ENABLED=false
ARG PUBLIC_BILLING=false
ARG PUBLIC_GOOGLE_SIGNIN=false
ARG PUBLIC_DASHBOARD_LINK=true
ARG PUBLIC_PRICING_REVIEWS=false
ARG PUBLIC_REVIEWED_ONLY=true
ARG PUBLIC_CONTACT_EMAIL=
ARG PUBLIC_PRIVACY_EMAIL=
ARG PUBLIC_SENTRY_DSN=
ARG PUBLIC_SENTRY_ENVIRONMENT=
ARG PUBLIC_RELEASE=
ARG PUBLIC_RUM_SAMPLE_RATE=0.1
ARG PUBLIC_ANALYTICS_SAMPLE_RATE=1
ARG CSP_REPORT_ONLY=false
ENV PUBLIC_ORIGIN=${PUBLIC_ORIGIN} \
    PUBLIC_MEDIA_URL=${PUBLIC_MEDIA_URL} \
    PUBLIC_INTERVIEW_ENABLED=${PUBLIC_INTERVIEW_ENABLED} \
    PUBLIC_INTERVIEW_BOARD_ENABLED=${PUBLIC_INTERVIEW_BOARD_ENABLED} \
    PUBLIC_INTERVIEW_VOICE_ENABLED=${PUBLIC_INTERVIEW_VOICE_ENABLED} \
    PUBLIC_INTERVIEW_SYSTEMS=${PUBLIC_INTERVIEW_SYSTEMS} \
    PUBLIC_ASK_ENABLED=${PUBLIC_ASK_ENABLED} \
    PUBLIC_LABS_ENABLED=${PUBLIC_LABS_ENABLED} \
    PUBLIC_AGENT_LABS_ENABLED=${PUBLIC_AGENT_LABS_ENABLED} \
    PUBLIC_BILLING=${PUBLIC_BILLING} \
    PUBLIC_GOOGLE_SIGNIN=${PUBLIC_GOOGLE_SIGNIN} \
    PUBLIC_DASHBOARD_LINK=${PUBLIC_DASHBOARD_LINK} \
    PUBLIC_PRICING_REVIEWS=${PUBLIC_PRICING_REVIEWS} \
    PUBLIC_REVIEWED_ONLY=${PUBLIC_REVIEWED_ONLY} \
    PUBLIC_CONTACT_EMAIL=${PUBLIC_CONTACT_EMAIL} \
    PUBLIC_PRIVACY_EMAIL=${PUBLIC_PRIVACY_EMAIL} \
    PUBLIC_SENTRY_DSN=${PUBLIC_SENTRY_DSN} \
    PUBLIC_SENTRY_ENVIRONMENT=${PUBLIC_SENTRY_ENVIRONMENT} \
    PUBLIC_RELEASE=${PUBLIC_RELEASE} \
    PUBLIC_RUM_SAMPLE_RATE=${PUBLIC_RUM_SAMPLE_RATE} \
    PUBLIC_ANALYTICS_SAMPLE_RATE=${PUBLIC_ANALYTICS_SAMPLE_RATE} \
    CSP_REPORT_ONLY=${CSP_REPORT_ONLY}
RUN test -n "$PUBLIC_ORIGIN" || { echo 'PUBLIC_ORIGIN build arg is required' >&2; exit 1; }; \
    npm run build && npm run check:dist

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# tini as PID 1 forwards SIGTERM to node, which drains (scripts/serve.ts): /api/ready fails at
# once, in-flight requests get up to SHUTDOWN_GRACE_MS (30 s). An interview reply streams for up
# to a minute: give the container a stop timeout of at least 35 s.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4322
# As deep as the build's /src/lego-ai/app: the lockfile's link to the content kit (file:../../lego/content-kit)
# resolves to the path it records, or npm ci discards the lockfile.
WORKDIR /src/lego-ai/app
COPY app/package.json app/package-lock.json ./
# The content kit is a dev dependency (inlined into the server bundle), so it isn't installed here.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/lego-ai/app/dist ./dist
# Ops scripts: the interview's switch and allowlist (node scripts/interview-switch.mjs), the cost
# report, and the edge router (docker compose).
COPY --from=build /src/lego-ai/app/scripts ./scripts
COPY --from=build /src/lego-ai/app/routes.mjs ./routes.mjs
# The content snapshot the server reads on first use (src/lib/content-snapshot.ts).
COPY --from=build /src/lego-ai/app/.content/snapshot.json ./.content/snapshot.json
ARG PUBLIC_RELEASE=
ENV RELEASE=${PUBLIC_RELEASE}
USER node
EXPOSE 4322
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4322)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/serve.ts"]
