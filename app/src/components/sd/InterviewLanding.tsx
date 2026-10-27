import type { ReactNode } from "react";
import type { InterviewPage } from "../../lib/interview.node";
import { systemSubject } from "../../lib/subject";
import { formatTwoDigits } from "../../i18n/format";
import t from "../../i18n/messages/interview";
import "../../styles/interview.css";
import "../../styles/landing.css";

// Mock interview landing (design 20a): what you'll explain, stage by stage, and what it is scored on on the
// left; the start card with its consent on the right; the drills under it. One per system (P3-11): the stages,
// their minutes and the dimensions come from the system's plan (content/interviews/<system>.yaml). The same
// page starts a drill and a coach lesson. The start card's body (sign in, consent, start or resume, the last
// session) is InterviewApp's.

type Props = {
  page: InterviewPage;
  /** The start card's body. */
  action: ReactNode;
  /** What starting costs, under the start card's title ("Uses 1 of your 5 voice sessions…"); null until known. */
  usage?: string | null;
  /** The drill this page is on (docs/README.md, "Drills"), or null for the system's page. */
  scope?: { topic: string; section: string | null } | null;
  /** The system has a whole interview (its page lists the drills under it); false on a concept system, whose page is the drills. */
  systemFull?: boolean;
  /** A coach lesson's page (docs/coach-mode.md): the same plan, taught instead of asked; or the mock interview's. */
  kind?: "interview" | "coach";
};

const VOICE_BUILD = import.meta.env.PUBLIC_INTERVIEW_VOICE_ENABLED === "true";

type Group = "understand" | "develop" | "evaluate" | "feedback";

/** Each stage kind's phase: understand the system, develop the design, evaluate it. */
const GROUP: Record<InterviewPage["stages"][number]["kind"], Group> = {
  requirements: "understand",
  "high-level": "understand",
  "data-api": "develop",
  "deep-dive": "develop",
  "wrap-up": "evaluate",
};
/** Topics (drills) take the phases in order. */
const CYCLE: Group[] = ["understand", "develop", "evaluate"];
const GROUP_LABEL = {
  understand: "group.understand",
  develop: "group.develop",
  evaluate: "group.evaluate",
  feedback: "group.feedback",
} as const;

/** The session's stages plus the feedback minutes, in order, each with the minute it starts at. */
export function timeline(
  page: Pick<InterviewPage, "stages" | "feedbackMinutes"> & {
    sections?: InterviewPage["sections"];
  },
) {
  // A derived stage's title joins its sections' headings ("What a URL shortener does and what it must do…"): the
  // row says the first heading, the title is its tooltip.
  const heading = (key: string | undefined) =>
    page.sections?.find((x) => x.key === key)?.title;
  const stages = [
    ...page.stages.map((s) => {
      const first = s.sections.length > 1 ? heading(s.sections[0]) : undefined;
      return {
        key: s.key,
        label: first ?? s.title,
        title: s.title,
        min: s.minutes,
        group: GROUP[s.kind],
      };
    }),
    ...(page.feedbackMinutes
      ? [
          {
            key: "feedback",
            label: t("stage.feedback.written"),
            title: t("stage.feedback.written"),
            min: page.feedbackMinutes,
            group: "feedback" as const,
          },
        ]
      : []),
  ];
  const total = stages.reduce((n, s) => n + s.min, 0);
  const ticks = stages
    .reduce<number[]>((acc, s) => [...acc, acc[acc.length - 1] + s.min], [0])
    .slice(0, -1);
  return { stages, total, ticks };
}

/** The drills as topics, each with its sections (interview.node.ts drillList order: a topic, then its sections). */
export function drillGroups(drills: InterviewPage["drills"]) {
  const groups: {
    topic: InterviewPage["drills"][number];
    sections: InterviewPage["drills"];
  }[] = [];
  for (const d of drills) {
    if (!d.section) groups.push({ topic: d, sections: [] });
    else groups.find((g) => g.topic.topic === d.topic)?.sections.push(d);
  }
  return groups;
}

/** The system's drills, by topic: shorter sessions on one topic or one section. */
function Drills({
  page,
  concept,
  coach,
}: {
  page: InterviewPage;
  concept: boolean;
  coach: boolean;
}) {
  const groups = drillGroups(page.drills);
  if (!groups.length) return null;
  // A lesson's drills open as lessons.
  const href = (h: string) =>
    coach ? `${h}${h.includes("?") ? "&" : "?"}kind=coach` : h;
  return (
    <section className="ivl-card" aria-labelledby="ivl-drills">
      <div className="ivl-card__intro">
        <h2 className="ivl-h2" id="ivl-drills">
          {t("drills.title")}
        </h2>
        <p className="ivl-small">
          {t(concept ? "drills.concept" : "drills.note")}
        </p>
      </div>
      <div className="ivl-drills">
        {groups.map((g, i) => (
          <div
            key={g.topic.topic}
            className={`ivl-drill ivl-g-${CYCLE[i % CYCLE.length]}`}
          >
            <a className="ivl-drill__head" href={href(g.topic.href)}>
              <span className="ivl-drill__title">{g.topic.title}</span>
              <span className="ivl-mono">
                {t("minutes", { minutes: g.topic.minutes })}
              </span>
            </a>
            {g.sections.length > 0 && (
              <ul className="ivl-drill__rows">
                {g.sections.map((s) => (
                  <li key={s.section}>
                    <a href={href(s.href)}>
                      {s.title}
                      <span className="ivl-mono ivl-mono--faint">
                        {t("tick", { minutes: s.minutes })}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function InterviewLanding({
  page,
  action,
  usage = null,
  scope = null,
  systemFull = true,
  kind = "interview",
}: Props) {
  const { system } = page;
  const { stages, total, ticks } = timeline(page);
  const coach = kind === "coach";
  const interviewHref =
    page.course?.hub ??
    `/systems/${system.slug}/interview${coach ? "?kind=coach" : ""}`;
  // The same page as the other kind (the lesson's as an interview, and back), scope kept.
  const drillQuery = scope
    ? `topic=${encodeURIComponent(scope.topic)}${scope.section ? `&section=${encodeURIComponent(scope.section)}` : ""}`
    : "";
  const otherHref =
    !coach && !scope && page.classroom
      ? page.classroom
      : `/systems/${system.slug}/interview${coach ? (drillQuery ? `?${drillQuery}` : "") : `?${drillQuery ? `${drillQuery}&` : ""}kind=coach`}`;
  // A concept system's page (no whole interview): the drills are the content.
  const conceptPage = !scope && !page.full;
  // The system's whole mock interview: the page asks its question (design 20a).
  const whole = !coach && !scope && !conceptPage;
  const groups = [...new Set(stages.map((s) => s.group))];
  const subject = systemSubject(system.name, page.title);
  const cardTitle = whole
    ? t("start.design", { subject })
    : scope
      ? scope.section
        ? t("start.section")
        : t("start.topic", { count: page.stages.length })
      : conceptPage
        ? t("session.concept")
        : coach
          ? page.course
            ? page.title
            : t("coach.start.full", { count: page.stages.length })
          : t("start.full", { count: page.stages.length });
  const cardLabel = t(
    coach
      ? page.course
        ? "coach.start.lesson"
        : "coach.start.label"
      : whole
        ? "start.label.full"
        : "start.label",
  );
  const meta = t(VOICE_BUILD ? "start.meta.voice" : "start.meta", {
    minutes: total,
  });
  // Three columns for many short stages, as in the design; two when the labels are long.
  const columns =
    stages.length > 6 && Math.max(...stages.map((s) => s.label.length)) <= 28
      ? 3
      : 2;

  return (
    <div className="lp">
      {/* No bar of its own: the site's header and mode bar are above it (the shell's page, lego/web RemotePage.astro). */}
      <main className="lp-in" id="content" tabIndex={-1}>
        <div className="lp-main">
          <div className="lp-head">
            <p className="lp-kicker">
              {t(
                coach
                  ? scope
                    ? "coach.kicker.drill"
                    : "coach.kicker"
                  : scope
                    ? "kicker.drill"
                    : conceptPage
                      ? "kicker.concept"
                      : "kicker.evaluation",
              )}
              <span className="lp-beta">{t("beta")}</span>
            </p>
            <h1 className="lp-title">
              {whole ? (
                <>
                  {t("title.explain", { subject })}{" "}
                  <span>{t("title.explain.why")}</span>
                </>
              ) : (
                page.title
              )}
            </h1>
            <p className="lp-lede">
              {whole
                ? t(VOICE_BUILD ? "lede.evaluation.voice" : "lede.evaluation", {
                    minutes: total,
                  })
                : page.course
                  ? page.summary
                  : coach
                    ? t("coach.lede")
                    : page.summary}
            </p>
            {scope && (
              <p className="lp-back">
                <a className="lp-link" href={interviewHref}>
                  {t(systemFull ? "drill.back" : "drill.backDrills", {
                    system: system.name,
                  })}
                </a>
              </p>
            )}
            {page.course && (
              <p className="lp-back">
                <a className="lp-link" href={page.course.hub}>
                  {t("coach.course.back")}
                </a>
              </p>
            )}
          </div>

          {stages.length > 0 && (
            <section className="lp-list" aria-labelledby="lp-stages">
              <div className="lp-list__head">
                <h2 className="lp-label" id="lp-stages">
                  {t(coach ? "coach.stages.order" : "stages.order")}
                </h2>
                <ul className="lp-legend" aria-label={t("timeline.key")}>
                  {groups.map((g) => (
                    <li key={g}>
                      <span
                        className={`lp-dot lp-dot--${g}`}
                        aria-hidden="true"
                      />
                      {t(GROUP_LABEL[g])}
                    </li>
                  ))}
                </ul>
              </div>
              <ol
                className="lp-rows"
                style={{ ["--lp-cols" as string]: columns }}
              >
                {stages.map((s, i) => (
                  <li key={s.key} className="lp-row">
                    <span className="lp-row__n">{formatTwoDigits(i + 1)}</span>
                    <span
                      className="lp-row__title"
                      title={s.title === s.label ? undefined : s.title}
                    >
                      <span
                        className={`lp-dot lp-dot--${s.group}`}
                        aria-hidden="true"
                      />
                      {s.label}
                    </span>
                    <span
                      className="lp-row__min"
                      title={t("minutes", { minutes: s.min })}
                    >
                      {t("stage.at", { minutes: ticks[i] })}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {conceptPage && <Drills page={page} concept coach={coach} />}

          {(stages.length > 0 || !page.course) && (
            <div className="lp-foot">
              {!coach && stages.length > 0 && page.dimensions.length > 0 && (
                <>
                  <span className="lp-label">{t("scored.on")}</span>
                  <ul className="lp-chips">
                    {page.dimensions.map((d) => (
                      <li key={d.key} title={d.description ?? undefined}>
                        {d.title}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <span className="lp-foot__gap" />
              {!conceptPage && !page.course && (
                <p className="lp-other">
                  {t.rich(coach ? "coach.switchBack" : "coach.switch", {
                    link: (text, key) => (
                      <a key={key} className="lp-link" href={otherHref}>
                        {text}
                      </a>
                    ),
                  })}
                </p>
              )}
            </div>
          )}
        </div>

        <aside className="lp-card" aria-labelledby="lp-start">
          <div className="lp-card__head">
            <span className="lp-card__label">{cardLabel}</span>
            <h2 className="lp-card__title" id="lp-start">
              {cardTitle}
            </h2>
            {stages.length > 0 && <span className="lp-card__meta">{meta}</span>}
            {usage && (
              <span className="lp-card__meta lp-card__usage">{usage}</span>
            )}
          </div>
          <div className="lp-card__body">{action}</div>
        </aside>
      </main>
      {!conceptPage && !scope && page.drills.length > 0 && (
        <div className="lp-more">
          <Drills page={page} concept={false} coach={coach} />
        </div>
      )}
    </div>
  );
}
