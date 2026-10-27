import { useSyncExternalStore, type ReactNode } from 'react';
import { topicLink } from '../../lib/auth-state';
import type { InterviewPage } from '../../lib/interview.node';
import { useAuthState } from '../../lib/use-auth-state';
import { formatTwoDigits } from '../../i18n/format';
import t from '../../i18n/messages/interview';
import '../../styles/interview.css';

// Mock interview landing (design 16a): the timeline as the hero, the skills and how it works as
// tiles, the drills grouped by topic, and the start card with its consent on the right. One per
// system (P3-11): the stages, their minutes, the dimensions and the checklist come from the
// system's plan (content/interviews/<system>.yaml). The start card's body (sign in, consent,
// start or resume, past sessions) is InterviewApp's.

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
  kind?: 'interview' | 'coach';
};

const VOICE_BUILD = import.meta.env.PUBLIC_INTERVIEW_VOICE_ENABLED === 'true';

type Group = 'understand' | 'develop' | 'evaluate' | 'feedback';

/** Each stage kind's phase on the timeline: understand the system, develop the design, evaluate it. */
const GROUP: Record<InterviewPage['stages'][number]['kind'], Group> = {
  requirements: 'understand',
  'high-level': 'understand',
  'data-api': 'develop',
  'deep-dive': 'develop',
  'wrap-up': 'evaluate',
};
/** Topics (drills, reading) take the phases in order. */
const CYCLE: Group[] = ['understand', 'develop', 'evaluate'];
const GROUP_LABEL = { understand: 'group.understand', develop: 'group.develop', evaluate: 'group.evaluate', feedback: 'group.feedback' } as const;
const RATINGS = ['rating.1', 'rating.2', 'rating.3', 'rating.4'] as const;

/** The session's stages plus the feedback minutes, in order; minutes size the tiles and place the ticks. */
export function timeline(page: Pick<InterviewPage, 'stages' | 'feedbackMinutes'>) {
  const stages = [
    ...page.stages.map((s) => ({ key: s.key, label: s.title, min: s.minutes, group: GROUP[s.kind] })),
    ...(page.feedbackMinutes ? [{ key: 'feedback', label: t('stage.feedback'), min: page.feedbackMinutes, group: 'feedback' as const }] : []),
  ];
  const total = stages.reduce((n, s) => n + s.min, 0);
  const ticks = stages.reduce<number[]>((acc, s) => [...acc, acc[acc.length - 1] + s.min], [0]).slice(0, -1);
  return { stages, total, ticks };
}

/** The drills as topics, each with its sections (interview.node.ts drillList order: a topic, then its sections). */
export function drillGroups(drills: InterviewPage['drills']) {
  const groups: { topic: InterviewPage['drills'][number]; sections: InterviewPage['drills'] }[] = [];
  for (const d of drills) {
    if (!d.section) groups.push({ topic: d, sections: [] });
    else groups.find((g) => g.topic.topic === d.topic)?.sections.push(d);
  }
  return groups;
}

const NotesIcon = ({ light }: { light?: boolean }) => (
  <svg className="ivl-notes" width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="15" rx="2" className={light ? 'is-accent' : undefined} />
    <path d="M4.5 6H11.5M4.5 9H11.5M4.5 12H9" className={light ? undefined : 'is-accent'} />
  </svg>
);

function Flow() {
  return (
    <div className="ivl-flow" aria-hidden="true">
      <div className="ivl-flow__node">
        <span className="ivl-flow__tile">
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="7" r="3.5" />
            <path d="M3.5 18C4.5 14 7 12.5 10 12.5S15.5 14 16.5 18" />
          </svg>
        </span>
        {t('talk.you')}
      </div>
      <div className="ivl-flow__link">
        <span>{VOICE_BUILD ? t('talk.speaks') : t('talk.types')}</span>
        <i />
      </div>
      <div className="ivl-flow__node">
        <span className="ivl-flow__tile is-ink">
          <svg width="22" height="20" viewBox="0 0 22 20">
            <rect x="3" y="5" width="16" height="12" rx="3" />
            <circle cx="8.5" cy="11" r="1.4" className="is-dot" />
            <circle cx="13.5" cy="11" r="1.4" className="is-dot" />
            <path d="M11 5V2" />
          </svg>
        </span>
        {t('talk.ai')}
      </div>
      <div className="ivl-flow__link is-out">
        <span>{t('talk.writes')}</span>
        <i />
      </div>
      <div className="ivl-flow__node is-wide">
        <span className="ivl-flow__tile is-paper">
          <NotesIcon />
        </span>
        {t('talk.feedback')}
      </div>
    </div>
  );
}

// "Get ready" ticks, kept in this browser. The landing is rendered on the server too, so the ticks
// come through an external store: none on the server and at hydration, then the browser's.
const readyKey = (system: string) => `interview:ready:${system}`;
const readyListeners = new Set<() => void>();
const subscribeReady = (fn: () => void) => {
  readyListeners.add(fn);
  window.addEventListener('storage', fn);
  return () => {
    readyListeners.delete(fn);
    window.removeEventListener('storage', fn);
  };
};
const rawReady = (system: string) => {
  try {
    return localStorage.getItem(readyKey(system)) ?? '[]';
  } catch {
    return '[]';
  }
};
const parseReady = (raw: string): string[] => {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
};

/** "Get ready": the topics to read first and what to have ready, ticked off in this browser. */
function GetReady({ page }: { page: InterviewPage }) {
  const auth = useAuthState();
  const raw = useSyncExternalStore(subscribeReady, () => rawReady(page.system.slug), () => '[]');
  const ticks = parseReady(raw);
  const items = [...page.readFirst.map((r) => `read:${r.title}`), ...page.checklist.map((c) => `have:${c}`)];
  if (!items.length) return null;
  const toggle = (key: string) => {
    const next = ticks.includes(key) ? ticks.filter((k) => k !== key) : [...ticks, key];
    try {
      localStorage.setItem(readyKey(page.system.slug), JSON.stringify(next));
    } catch {
      // A private window or blocked storage: the box stays as it was.
    }
    for (const fn of readyListeners) fn();
  };
  const box = (key: string, label: ReactNode, extra?: ReactNode) => (
    <li key={key} className="ivl-ready__item">
      <input type="checkbox" checked={ticks.includes(key)} onChange={() => toggle(key)} aria-labelledby={`ivl-r-${key}`} />
      <span id={`ivl-r-${key}`} className="ivl-ready__text">
        {label}
      </span>
      {extra}
    </li>
  );
  return (
    <section className="ivl-card ivl-ready" aria-labelledby="ivl-ready">
      <div className="ivl-card__head">
        <h2 className="ivl-h3" id="ivl-ready">
          {t('ready.title')}
        </h2>
        <span className="ivl-count">{`${ticks.filter((k) => items.includes(k)).length} / ${items.length}`}</span>
      </div>
      {page.readFirst.length > 0 && (
        <div className="ivl-ready__group">
          <span className="ivl-label">{t('ready.read')}</span>
          <ul>
            {page.readFirst.map((r, i) =>
              box(
                `read:${r.title}`,
                r.href ? <a href={topicLink(r.href, auth)}>{r.title}</a> : r.title,
                <span className={`ivl-swatch ivl-g-${CYCLE[i % CYCLE.length]}`} aria-hidden="true" />,
              ),
            )}
          </ul>
        </div>
      )}
      {page.checklist.length > 0 && (
        <div className="ivl-ready__group">
          <span className="ivl-label">{t('ready.have')}</span>
          <ul>{page.checklist.map((c) => box(`have:${c}`, c))}</ul>
        </div>
      )}
    </section>
  );
}

function Drills({ page, concept, coach }: { page: InterviewPage; concept: boolean; coach: boolean }) {
  const groups = drillGroups(page.drills);
  if (!groups.length) return null;
  // A lesson's drills open as lessons.
  const href = (h: string) => (coach ? `${h}${h.includes('?') ? '&' : '?'}kind=coach` : h);
  return (
    <section className="ivl-card" aria-labelledby="ivl-drills">
      <div className="ivl-card__intro">
        <h2 className="ivl-h2" id="ivl-drills">
          {t('drills.title')}
        </h2>
        <p className="ivl-small">{t(concept ? 'drills.concept' : 'drills.note')}</p>
      </div>
      <div className="ivl-drills">
        {groups.map((g, i) => (
          <div key={g.topic.topic} className={`ivl-drill ivl-g-${CYCLE[i % CYCLE.length]}`}>
            <a className="ivl-drill__head" href={href(g.topic.href)}>
              <span className="ivl-drill__title">{g.topic.title}</span>
              <span className="ivl-mono">{t('minutes', { minutes: g.topic.minutes })}</span>
            </a>
            {g.sections.length > 0 && (
              <ul className="ivl-drill__rows">
                {g.sections.map((s) => (
                  <li key={s.section}>
                    <a href={href(s.href)}>
                      {s.title}
                      <span className="ivl-mono ivl-mono--faint">{t('tick', { minutes: s.minutes })}</span>
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

export default function InterviewLanding({ page, action, usage = null, scope = null, systemFull = true, kind = 'interview' }: Props) {
  const { system } = page;
  const { stages, total, ticks } = timeline(page);
  // A playlist's lesson (docs/coaching.md) belongs to its playlist's page.
  const coach = kind === 'coach';
  const interviewHref = page.course?.hub ?? `/systems/${system.slug}/interview${coach ? '?kind=coach' : ''}`;
  // The same page as the other kind (the lesson's as an interview, and back), scope kept.
  const drillQuery = scope ? `topic=${encodeURIComponent(scope.topic)}${scope.section ? `&section=${encodeURIComponent(scope.section)}` : ''}` : '';
  const otherHref = `/systems/${system.slug}/interview${coach ? (drillQuery ? `?${drillQuery}` : '') : `?${drillQuery ? `${drillQuery}&` : ''}kind=coach`}`;
  // A concept system's page (no whole interview): the drills are the content.
  const conceptPage = !scope && !page.full;
  const columns = stages.map((s) => `${Math.max(1, s.min)}fr`).join(' ');
  const groups = [...new Set(stages.map((s) => s.group))];
  const facts = coach
    ? [
        { label: t('fact.length'), value: t('fact.length.value', { minutes: total }) },
        { label: t('fact.format'), value: VOICE_BUILD ? t('coach.fact.format.voice') : t('coach.fact.format') },
        { label: t('coach.fact.coach'), value: t('coach.fact.coach.value') },
        { label: t('coach.fact.end'), value: t('coach.fact.end.value') },
      ]
    : [
        { label: t('fact.length'), value: t('fact.length.value', { minutes: total }) },
        { label: t('fact.format'), value: VOICE_BUILD ? t('fact.format.voice') : t('fact.format.value') },
        { label: t('fact.interviewer'), value: t('fact.interviewer.value') },
        { label: t('fact.feedback'), value: t('fact.feedback.value') },
      ];
  const cardTitle = scope
    ? scope.section
      ? t('start.section')
      : t('start.topic', { count: page.stages.length })
    : conceptPage
      ? t('session.concept')
      : coach
        ? t('coach.start.full', { count: page.stages.length })
        : t('start.full', { count: page.stages.length });

  return (
    <div className="iv">
      {/* No bar of its own: the site's header and mode bar are above it (the shell's page, lego/web RemotePage.astro). */}

      <div className="ivl">
        <main className="ivl-main" id="content" tabIndex={-1}>
          <section className="ivl-card ivl-hero">
            <div className="ivl-hero__text">
              <span className="ivl-kicker">
                {t(coach ? (scope ? 'coach.kicker.drill' : 'coach.kicker') : scope ? 'kicker.drill' : conceptPage ? 'kicker.concept' : 'kicker')}
                <span className="ivl-beta">{t('beta')}</span>
              </span>
              <h1 className="ivl-title">{page.title}</h1>
              <p className="ivl-lede">{page.course ? page.summary : coach ? t('coach.lede') : page.summary}</p>
              {scope && (
                <p className="ivl-back">
                  <a href={interviewHref}>{t(systemFull ? 'drill.back' : 'drill.backDrills', { system: system.name })}</a>
                </p>
              )}
              {!conceptPage && !page.course && (
                <p className="ivl-back">{t.rich(coach ? 'coach.switchBack' : 'coach.switch', { link: (text, key) => <a key={key} href={otherHref}>{text}</a> })}</p>
              )}
            </div>
            {stages.length > 0 && (
              <dl className="ivl-facts">
                {facts.map((f) => (
                  <div key={f.label} className="ivl-fact">
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {stages.length > 0 && (
              <section className="ivl-timeline" aria-labelledby="ivl-timeline">
                <div className="ivl-card__head">
                  <h2 className="ivl-label" id="ivl-timeline">
                    {t(coach ? 'coach.timeline.run' : 'timeline.run', { minutes: total })}
                  </h2>
                  <ul className="ivl-legend" aria-label={t('timeline.key')}>
                    {groups.map((g) => (
                      <li key={g}>
                        <span className={`ivl-swatch ivl-g-${g}`} aria-hidden="true" />
                        {t(GROUP_LABEL[g])}
                      </li>
                    ))}
                  </ul>
                </div>
                <ol className="ivl-tiles" style={{ gridTemplateColumns: columns }}>
                  {stages.map((s, i) => (
                    <li key={s.key} className={`ivl-tile ivl-g-${s.group}`} title={t('minutes', { minutes: s.min })}>
                      {s.group === 'feedback' ? (
                        <>
                          <NotesIcon light />
                          <span className="sr-only">{s.label}</span>
                        </>
                      ) : (
                        <>
                          <span className="ivl-tile__n">{formatTwoDigits(i + 1)}</span>
                          <span className="ivl-tile__title">{s.label}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
                <div className="ivl-ticks" style={{ gridTemplateColumns: columns }} aria-hidden="true">
                  {ticks.map((tick) => (
                    <span key={tick}>{t('tick', { minutes: tick })}</span>
                  ))}
                </div>
              </section>
            )}
          </section>

          {stages.length > 0 && (
            <div className="ivl-pair">
              <section className="ivl-card" aria-labelledby="ivl-skills">
                <div className="ivl-card__head">
                  <h2 className="ivl-h2" id="ivl-skills">
                    {t('assessed')}
                  </h2>
                  <span className="ivl-count">{t('skills.count', { count: page.dimensions.length })}</span>
                </div>
                <ul className="ivl-chips">
                  {page.dimensions.map((d) => (
                    <li key={d.key} title={d.description ?? undefined}>
                      {d.title}
                    </li>
                  ))}
                </ul>
                <div className="ivl-scale">
                  <span className="ivl-label">{t('skills.rated')}</span>
                  <div className="ivl-scale__bars" aria-hidden="true">
                    {RATINGS.map((r, i) => (
                      <span key={r} className={`ivl-r${i + 1}`} />
                    ))}
                  </div>
                  <ul className="ivl-scale__names">
                    {RATINGS.map((r) => (
                      <li key={r}>{t(r)}</li>
                    ))}
                  </ul>
                </div>
              </section>
              <section className="ivl-card" aria-labelledby="ivl-how">
                <h2 className="ivl-h2" id="ivl-how">
                  {t('talk')}
                </h2>
                <Flow />
                <p className="ivl-small">{VOICE_BUILD ? t('talk.caption') : t('talk.captionText')}</p>
              </section>
            </div>
          )}

          {(conceptPage || !scope) && <Drills page={page} concept={conceptPage} coach={coach} />}
        </main>

        <aside className="ivl-side">
          <section className="ivl-card ivl-start" aria-labelledby="ivl-start">
            <div className="ivl-start__head">
              <span className="ivl-label ivl-label--accent">{t(coach ? 'coach.start.label' : 'start.label')}</span>
              <h2 className="ivl-start__title" id="ivl-start">
                {cardTitle}
              </h2>
              {usage && <span className="ivl-start__usage">{usage}</span>}
            </div>
            <div className="ivl-start__body">{action}</div>
          </section>
          <GetReady page={page} />
        </aside>
      </div>
    </div>
  );
}
