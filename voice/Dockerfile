# The voice service (docs/README.md, "Voice"): Python 3.12, Pipecat 1.13, one process.
# Built from the lego-ai repository root: docker build -f voice/Dockerfile -t arrowbox-interview-voice .
FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv
WORKDIR /app
COPY voice/pyproject.toml ./
RUN uv pip install --system --no-cache -r pyproject.toml
COPY voice/app ./app
COPY voice/bot ./bot
# Its own user and group: Debian's base image already has a system group named voice.
RUN groupadd --system --gid 10001 pipecat && useradd --system --uid 10001 --gid pipecat pipecat && chown -R pipecat:pipecat /app
USER pipecat
EXPOSE 7860
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD curl -sf http://127.0.0.1:7860/health || exit 1
# SIGTERM: the supervisor parks every session (the rooms rejoin on another task); the ECS stopTimeout is 120 s.
CMD ["python", "-m", "app.main"]
