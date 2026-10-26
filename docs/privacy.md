# Mock interview: consent, Permissions-Policy and retention

What the mock interview collects, what the candidate agrees to before a session, how long anything
is kept, and what the browser is allowed to do on the interview pages (P3-11, GAP3-4). The design
is in [README.md](README.md).

> **Not legal text.** This is the engineering record of what the product does. The consent wording
> in the room and the privacy policy's interview section must be written or approved by counsel
> before the beta opens (see "For legal review" below). Nothing here has been reviewed.

## What is collected, by phase

| Data | Text beta (now) | Whiteboard beta | Voice (phase 3) |
|---|---|---|---|
| The candidate's typed messages and the interviewer's replies (the transcript) | kept | kept | the speech-to-text transcript, kept |
| Stage timings, message count, estimated cost | kept with the session | kept | kept |
| Written feedback | kept | kept | kept |
| Consent record (version and time) | kept with the session | kept | kept, plus a recording consent |
| Whiteboard contents | none | kept with the session: the scene, a text snapshot per stage, and the PNGs the room renders (one per stage, plus the current one for the vision fallback) | kept |
| Raw audio | none | none | **not stored** by default: streamed to Deepgram for transcription and dropped. With the candidate's opt-in (`audioOptIn`, a checkbox in the voice consent) the service may keep the session's audio for 7 days for QA; the beta's service has the setting (`VOICE_AUDIO_DIR`) but writes nothing yet |
| Microphone or camera access | none: `Permissions-Policy: microphone=()` on every page | none | microphone on the room page only (`microphone=(self)`), asked for from the start button's click |
| Speech vendors | none | none | Deepgram (speech-to-text, Nova-3, `en-IN`), Cartesia (text-to-speech), Daily (the WebRTC room; its servers carry the audio, no recording) |

Sessions are tied to the reader's account (the Strapi user's documentId) and stored in the shared
store (Redis) under `interview:*` keys. Messages go to Anthropic, the AI provider already named for
Ask, to write the replies and the feedback. No other processor receives interview data in the text
beta. In the whiteboard beta the board goes to the same provider: as text on every reply, and as
images (the PNGs) to the small model that describes a freehand board and to the grader at the end.

## Consent, before every session

The landing page's session card shows, before "Agree and start" is enabled (`InterviewApp.tsx`):

- the interviewer is an AI, and the messages go to the AI provider to write replies and feedback;
- the session is text only; nothing is recorded from the microphone or camera;
- the transcript and feedback are kept for `INTERVIEW_RETENTION_DAYS` days (30 by default) and
  can be deleted sooner, one session at a time or with the account;
- not to include personal or confidential information;
- that the session uses one of the month's sessions;
- a link to the privacy policy.

The server refuses to start a session without the current consent version
(`CONSENT_VERSION` in `web/src/lib/server/interview/config.ts`) and stores
`{ version, at }` on the session. **Bump the version whenever the consent text changes**, so every
session records exactly what its candidate agreed to.

Consent is per session, not a one-time account setting: the beta changes quickly, and a session is
a deliberate act.

**Voice consent** (`VOICE_CONSENT_VERSION` in config.ts; the second start button in
`InterviewApp.tsx`) replaces two of the bullets and adds two:

- the interviewer is an AI; speech is transcribed and spoken by the speech providers (Deepgram and
  Cartesia); the words go to Anthropic to write the replies and the feedback;
- the microphone is on for the whole session; the audio is streamed for transcription and not
  stored; only the transcript is kept;
- an **optional** checkbox: keep this session's audio for 7 days to improve the interviewer
  (`audioOptIn`, stored on the session; nothing is written in the beta);
- that the session uses one of the month's voice sessions (about the plan's minutes).

This is recording consent in substance (a transcript of speech is made), and the candidate is the
only human party; some US states require every party to a recorded conversation to agree, which
this step gives. Counsel must confirm the wording, the opt-in and whether the transcript of speech
changes the retention period.

## Retention, deletion and export

- **Retention:** a session expires `INTERVIEW_RETENTION_DAYS` after it started (a store TTL set on
  every write). Nothing about it outlives that: the reader's index of sessions drops expired ones.
- **Coaching progress** (docs/coaching.md, "The learner's thread"): for a playlist's lessons, the
  reader's standing per lesson (finished or not, the lesson's points that held or stayed shaky, the
  questions the coach parked), kept for the same `INTERVIEW_RETENTION_DAYS` from its last update.
  It holds the points' own words and the reader's parked questions, never transcripts.
- **Delete one session:** "Delete this session now" in the room (`DELETE /api/interview/<id>`).
- **Delete the account:** `/api/account` deletion also deletes every interview session and the
  coaching progress (`deleteReaderContent` in `web/src/lib/server/account.ts`).
- **Export:** the account export (`/api/account/export`) includes an `interviews` array (sessions
  with transcripts, feedback and consent) when the reader has any, and a `coaching` object (the
  progress per playlist).
- **Logs** carry the session id, stage, token counts and cost, and a hash of the reader id, never
  the messages.
- **Backups:** Redis is not backed up for interview data; when sessions move to the interview
  service's Postgres (README, "Target architecture"), its backups must honour the same retention.

## Permissions-Policy and CSP

Every page and API response already sends
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` and a strict CSP
(`web/src/lib/server/security-headers.ts`). The text beta and the whiteboard beta need no change:
the room runs under the same policy, so no page can ask for the microphone.

For voice, only the room route relaxes the policy, and only as far as it must (built:
`roomCsp({voice})` and `securityHeaders(…, {microphone})` in security-headers.ts, applied by
astro.config.mjs to `/systems/<system>/interview` in a `PUBLIC_INTERVIEW_VOICE_ENABLED` build):

- `Permissions-Policy: microphone=(self)` on the room page only; every other page keeps
  `microphone=()`. Frames never get it (`frame-ancestors 'none'` stays).
- `script-src` and `connect-src` gain Daily's hosts (`*.daily.co` and its fallback domains
  `*.dailywebrtc.com`, `*.dailywebrtc.net`, plus their `wss:` forms): the call bundle daily-js
  loads at run time, signalling and media. No `'unsafe-eval'` (`avoidEval`). The speech vendors
  are never reached from the browser: audio goes to Daily, and the service talks to them.
- `getUserMedia` is called from the start button's click, after the consent step, once as a check
  (the stream is dropped) and then by Daily's client for the call; the call ends with the session,
  "switch to typing", or leaving the page.

## For legal review

Before the text beta opens to readers:

1. The consent wording in the session card (above), and whether per-session consent is right.
2. The privacy policy's section on the mock interview: purpose, what is kept, retention, deletion,
   the AI provider, and the lawful basis (consent or contract) for EU and UK readers.
3. The retention period (30 days is an engineering default).
4. Age limits, if the terms don't already cover them.

Before voice opens (the room is built and on staging): the voice consent above (recording
consent, all-party states), Deepgram, Cartesia and Daily as subprocessors and their DPAs, whether
any audio or voice-derived data could count as biometric, the 7-day audio opt-in, and whether
transcripts of speech change the retention period.
