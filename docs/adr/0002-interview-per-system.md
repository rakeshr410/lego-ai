# ADR 0002: The mock interview is per system

- **Status:** Accepted, 2026-09-27
- **Plan item:** P3-11 (production-readiness plan, Phase 3), first slice
- **Findings:** GAP3-5 (granularity), GAP3-2 (content-driven stages)
- **Design:** [docs/README.md](../README.md)

## Context

The interview landing page was generated once per readable topic
(`/systems/<system>/<topic>/interview`) and promised the same 45-minute arc everywhere: clarify
requirements, high level design, data model and API, deep dives, feedback. A topic such as "Email
and password login" cannot carry 45 minutes of system design, and the copy was hardcoded for every
topic ("You've read the requirements topic"). At 47 topics today and hundreds later, per-topic
interviews would also mean hundreds of rubrics to write and review (GAP3-5).

Real front end system design interviews are about a product ("design Instagram's web client"),
not one screen of it.

## Decision

1. **The unit is the system.** One interview per system, at `/systems/<system>/interview`. The
   per-topic pages are removed. A topic may not be named `interview` (lint rule `reserved-slug`).
2. **Everything that varies is content.** A system's plan lives in
   `content/interviews/<system>.yaml` (schema in `content-kit/src/interview.ts`): the problem
   statement, the stages with their minutes, what the interviewer says to open each stage, private
   notes and follow-ups, the signals a strong answer covers, the dimensions the feedback rates, the
   topics to read first. It is reviewed like a topic (the same editorial gate) and published like
   one (a reviewed-only build serves reviewed plans only).
3. **Topics feed the interview**, they don't each get one: a plan names the topics the candidate
   should read first and the topics each stage draws on (their tutor briefs ground the interviewer).
4. **Short per-topic drills are a later, separate product** (a 10-minute deep dive on one topic),
   if analytics show demand. They would get their own plan type, not reuse this one.

## Consequences

- 14 plans at most today, not 47. Authoring and review load drops by about 3x, and the grading
  rubric has one place per system.
- The URL is stable per system, and each system without a plan simply has no interview page.
- Plans are not mirrored to Strapi: nothing reads them from the CMS (the web reads the content
  snapshot, like Ask). If an editor UI is ever needed, a read-only mirror can be added to the sync.
- The interview cannot yet say "you read 3 of the 5 topics": that needs the server-side learner
  model (P3-1).
