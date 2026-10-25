import { useState, type CSSProperties, type ReactNode } from 'react';
import type { InterviewPage } from '../../lib/interview.node';
import t from '../../i18n/messages/interview';
import type { SessionView } from '../../pages/api/interview/index';
import '../../styles/interview-feedback.css';

// The finished session's feedback (design 15a, "dashboard"): the verdict, the stages reached and
// the time used up top; the stage track, whose reached stages open into what went well, what to
// work on and the checkpoint missed; a meter per skill; what to practise next and the topics not
// reached. The transcript waits behind "View transcript".

type Props = {
  page: InterviewPage;
  session: SessionView;
  /** The room's transcript, shown on "View transcript". */
  transcript: ReactNode;
  deleting: boolean;
  error: string;
  onDelete: () => void;
  /** Back to the interview's page, where a new session starts. */
  onRetry: () => void;
};

type Feedback = NonNullable<SessionView['feedback']>;
type Rating = Feedback['stages'][number]['rating'];
type Item = NonNullable<Feedback['items']>[number];

const RATING_KEYS = ['rating.0', 'rating.1', 'rating.2', 'rating.3', 'rating.4'] as const;
const ratingText = (r: Rating) => t(RATING_KEYS[r]);
/** The legend's order: best first, then not reached. */
const LEGEND: Rating[] = [4, 3, 2, 1, 0];
const SKILL_SCALE = ['feedback.scale.1', 'feedback.scale.2', 'feedback.scale.3', 'feedback.scale.4'] as const;

/** The summary's first sentence as the headline, the rest under it. */
export function splitSummary(summary: string): { head: string; rest: string } {
  const m = /^(.+?[.!?])(\s+)(\S[\s\S]*)$/.exec(summary.trim());
  return m ? { head: m[1], rest: m[3] } : { head: summary.trim(), rest: '' };
}

/** Whole minutes the session ran: from the start to its last turn, less the time a voice session sat parked. */
export function minutesUsed(session: Pick<SessionView, 'startedAt' | 'turns' | 'voice'>): number {
  const last = session.turns.reduce((max, turn) => Math.max(max, Date.parse(turn.at) || 0), 0);
  if (!last) return 0;
  const ms = last - Date.parse(session.startedAt) - (session.voice?.pausedMs ?? 0);
  return Math.max(0, Math.round(ms / 60_000));
}

/** The stage that opens first: the weakest one reached, the earliest on a tie; null when none was reached. */
export function firstOpen(stages: { key: string; rating: Rating }[]): string | null {
  let best: { key: string; rating: Rating } | null = null;
  for (const s of stages) if (s.rating > 0 && (!best || s.rating < best.rating)) best = s;
  return best?.key ?? null;
}

const storageKey = (id: string) => `interview:practised:${id}`;

function readPractised(id: string): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(id)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function Arrow() {
  return (
    <svg className="ivf-arrow" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
      <path d="M1 5H12M8 1L12 5L8 9" />
    </svg>
  );
}

export default function InterviewFeedback({ page, session, transcript, deleting, error, onDelete, onRetry }: Props) {
  const [showTranscript, setShowTranscript] = useState(false);
  const f = session.feedback;
  const kicker = [t('feedback.kicker'), page.system.name, session.scope ? t('crumb.drill') : null, t('feedback.title')].filter(Boolean).join(' · ');
  const length = t(session.mode === 'voice' ? 'feedback.lengthVoice' : 'feedback.length', { minutes: session.plannedMinutes });

  return (
    <main className="ivf" id="content" tabIndex={-1}>
      <div className="ivf-head">
        <div className="ivf-head__text">
          <span className="ivf-kicker">{kicker}</span>
          <h1 className="ivf-title">{page.title}</h1>
          <span className="ivf-sub">{length}</span>
        </div>
        <div className="ivf-head__actions">
          <span className="ivf-ended">
            <span aria-hidden="true" />
            {t('room.ended')}
          </span>
          <button type="button" className="ivf-btn" aria-expanded={showTranscript} aria-controls="ivf-transcript" onClick={() => setShowTranscript((v) => !v)}>
            {showTranscript ? t('feedback.hideTranscript') : t('feedback.viewTranscript')}
          </button>
          <button type="button" className="ivf-btn ivf-btn--danger" onClick={onDelete} disabled={deleting}>
            {deleting ? t('room.deleting') : t('feedback.delete')}
          </button>
        </div>
      </div>

      <div className="ivf-body">
        {error && (
          <div className="ivr-error" role="alert">
            {error}
          </div>
        )}
        {showTranscript && (
          <section id="ivf-transcript" className="ivf-card ivf-transcript">
            {transcript}
          </section>
        )}
        {f ? (
          <Dashboard page={page} session={session} feedback={f} onRetry={onRetry} />
        ) : (
          <section className="ivf-card">
            <h2 className="ivf-h2">{t('feedback.title')}</h2>
            <p className="ivf-text">{session.feedbackNote ?? t('feedback.none')}</p>
          </section>
        )}
        <footer className="ivf-foot">
          <span>{t('feedback.caveat')}</span>
          <span>{t('room.kept')}</span>
        </footer>
      </div>
    </main>
  );
}

function Dashboard({ page, session, feedback: f, onRetry }: { page: InterviewPage; session: SessionView; feedback: Feedback; onRetry: () => void }) {
  const ratingOf = (key: string): Rating => f.stages.find((s) => s.key === key)?.rating ?? 0;
  const stages = page.stages.map((s) => ({ ...s, rating: ratingOf(s.key) }));
  const [open, setOpen] = useState<string | null>(() => firstOpen(stages));
  const { head, rest } = splitSummary(f.summary);
  const section = (key: string) => page.sections.find((s) => s.key === key);
  const missed = (f.notCovered ?? []).map(section).filter((s): s is NonNullable<typeof s> => !!s);
  const weak = (f.weakAreas ?? []).map(section).filter((s): s is NonNullable<typeof s> => !!s);
  const openStage = stages.find((s) => s.key === open && s.rating > 0) ?? null;

  return (
    <>
      <div className="ivf-top">
        <section className="ivf-verdict" aria-labelledby="ivf-verdict">
          <span className="ivf-label" id="ivf-verdict">
            {t('feedback.verdict')}
          </span>
          <h2 className={`ivf-verdict__head${head.length > 90 ? ' is-long' : ''}`}>{head}</h2>
          {rest && <p className="ivf-verdict__rest">{rest}</p>}
          {f.nextSteps[0] && (
            <p className="ivf-verdict__next">
              <Arrow />
              <span>{f.nextSteps[0]}</span>
            </p>
          )}
        </section>
        <Reached stages={stages} />
        <TimeUsed session={session} stages={stages} />
      </div>

      <section className="ivf-card" aria-labelledby="ivf-stages">
        <div className="ivf-card__head">
          <h2 className="ivf-h2" id="ivf-stages">
            {t('feedback.byStage')}
          </h2>
          <ul className="ivf-legend" aria-label={t('feedback.legend')}>
            {LEGEND.map((r) => (
              <li key={r}>
                <span className={`ivf-dot ivf-r${r}`} aria-hidden="true" />
                {ratingText(r)}
              </li>
            ))}
          </ul>
        </div>
        <ol className="ivf-track" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(120px, 1fr))` }}>
          {stages.map((s, i) => {
            const reached = s.rating > 0;
            const isOpen = openStage?.key === s.key;
            const body = (
              <>
                <span className="ivf-track__rail">
                  <span className={`ivf-track__n ivf-r${s.rating}`}>{i + 1}</span>
                  {i < stages.length - 1 && <span className={`ivf-track__line${reached ? ' is-reached' : ''}`} />}
                </span>
                <span className="ivf-track__title">{s.title}</span>
                <span className={`ivf-chip ivf-r${s.rating}`}>{ratingText(s.rating)}</span>
              </>
            );
            return (
              <li key={s.key} className={`ivf-track__stage${isOpen ? ' is-open' : ''}${reached ? '' : ' is-unreached'}`}>
                {reached ? (
                  <button type="button" className="ivf-track__btn" aria-expanded={isOpen} aria-controls="ivf-stage" onClick={() => setOpen(s.key)}>
                    {body}
                  </button>
                ) : (
                  <div className="ivf-track__btn">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
        {openStage && <StageDetail stage={openStage} feedback={f} page={page} />}
      </section>

      <div className="ivf-lower">
        <section className="ivf-card" aria-labelledby="ivf-skills">
          <div className="ivf-card__head">
            <h2 className="ivf-h2" id="ivf-skills">
              {t('feedback.bySkill')}
            </h2>
            <div className="ivf-scale" aria-hidden="true">
              {SKILL_SCALE.map((k) => (
                <span key={k}>{t(k)}</span>
              ))}
            </div>
          </div>
          <ul className="ivf-skills">
            {f.dimensions.map((d) => (
              <li key={d.key} className={`ivf-skill${d.rating === 0 ? ' is-unreached' : ''}`}>
                <span className="ivf-skill__name">{page.dimensions.find((x) => x.key === d.key)?.title ?? d.key}</span>
                <span className="ivf-skill__note">{d.note}</span>
                <span className="ivf-meter" role="img" aria-label={ratingText(d.rating)}>
                  {d.rating === 0 ? (
                    <span className="ivf-meter__none" />
                  ) : (
                    [1, 2, 3, 4].map((n) => <span key={n} className={n <= d.rating ? `ivf-r${d.rating}` : undefined} />)
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="ivf-small">
            {t('feedback.dashed')} {f.sections && f.sections.length > 0 ? t('feedback.rulesShort') : ''}
          </p>
        </section>

        <div className="ivf-side">
          <Practise id={session.id} steps={f.nextSteps} onRetry={onRetry} />
          {weak.length > 0 && (
            <section className="ivf-card" aria-labelledby="ivf-weak">
              <div className="ivf-card__head">
                <h2 className="ivf-h3" id="ivf-weak">
                  {t('feedback.weak')}
                </h2>
                <span className="ivf-count">{t('feedback.weakCount', { count: weak.length })}</span>
              </div>
              <ul className="ivf-tags">
                {weak.map((s) => (
                  <li key={s.key} className="ivf-tag ivf-tag--solid">
                    {s.href ? <a href={s.href}>{s.title}</a> : s.title}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {missed.length > 0 && (
            <section className="ivf-card" aria-labelledby="ivf-missed">
              <div className="ivf-card__head">
                <h2 className="ivf-h3" id="ivf-missed">
                  {t('feedback.notCovered')}
                </h2>
                <span className="ivf-count">{t('feedback.missedCount', { count: missed.length })}</span>
              </div>
              <ul className="ivf-tags">
                {missed.map((s) => (
                  <li key={s.key} className="ivf-tag">
                    {s.href ? <a href={s.href}>{s.title}</a> : s.title}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** The ring of stages reached, an arc per reached stage in its rating's colour. */
function Reached({ stages }: { stages: { key: string; rating: Rating }[] }) {
  const R = 46;
  const C = 2 * Math.PI * R;
  const total = stages.length || 1;
  const reached = stages.filter((s) => s.rating > 0);
  const counts = LEGEND.map((r) => ({ r, n: stages.filter((s) => s.rating === r).length })).filter((c) => c.n > 0);
  const gap = reached.length > 1 ? 2 : 0;
  return (
    <section className="ivf-card ivf-stat" aria-labelledby="ivf-reached">
      <span className="ivf-label ivf-label--muted" id="ivf-reached">
        {t('feedback.reached')}
      </span>
      <div className="ivf-ring">
        <div className="ivf-ring__chart" role="img" aria-label={t('feedback.reachedOf', { n: reached.length, total: stages.length })}>
          <svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true">
            <circle className="ivf-ring__bg" cx="56" cy="56" r={R} />
            {reached.map((s, i) => (
              <circle
                key={s.key}
                className={`ivf-ring__arc ivf-r${s.rating}`}
                cx="56"
                cy="56"
                r={R}
                strokeDasharray={`${C / total - gap} ${C}`}
                strokeDashoffset={-(C / total) * i}
                transform="rotate(-90 56 56)"
              />
            ))}
          </svg>
          <span className="ivf-ring__n" aria-hidden="true">
            {reached.length}
            <small>/{stages.length}</small>
          </span>
        </div>
        <ul className="ivf-ring__key">
          {counts.map(({ r, n }) => (
            <li key={r}>
              <span className={`ivf-sq ivf-r${r}`} aria-hidden="true" />
              {t('feedback.countOf', { n, rating: ratingText(r).toLowerCase() })}
            </li>
          ))}
        </ul>
      </div>
      <p className="ivf-small">{t('feedback.notHeld')}</p>
    </section>
  );
}

function TimeUsed({ session, stages }: { session: SessionView; stages: { key: string; minutes: number }[] }) {
  const used = minutesUsed(session);
  const planned = session.plannedMinutes || stages.reduce((n, s) => n + s.minutes, 0) || 1;
  const share = Math.min(100, (used / planned) * 100);
  const columns = stages.map((s) => `${Math.max(1, s.minutes)}fr`).join(' ');
  const perStage = Math.round(planned / Math.max(1, stages.length));
  return (
    <section className="ivf-card ivf-stat" aria-labelledby="ivf-time">
      <span className="ivf-label ivf-label--muted" id="ivf-time">
        {t('feedback.timeUsed')}
      </span>
      <span className="ivf-big">
        ~{used}
        <small> {t('feedback.ofMinutes', { minutes: planned })}</small>
      </span>
      <div className="ivf-time" role="img" aria-label={t('feedback.timeOf', { used, minutes: planned })}>
        <div className="ivf-time__bar" style={{ gridTemplateColumns: columns }}>
          {stages.map((s) => (
            <span key={s.key} />
          ))}
          <span className="ivf-time__fill" style={{ width: `${Math.max(share, used > 0 ? 1.5 : 0)}%` }} />
        </div>
        <div className="ivf-time__ticks" style={{ gridTemplateColumns: columns }} aria-hidden="true">
          {stages.map((s, i) => (
            <span key={s.key}>{i + 1}</span>
          ))}
        </div>
      </div>
      <p className="ivf-small">{t('feedback.perStage', { minutes: perStage })}</p>
    </section>
  );
}

/** The checkpoint the stage missed (or got wrong): the first such item in the stage's sections. */
function checkpointOf(stageSections: string[], items: Item[]): Item | null {
  const own = items.filter((i) => stageSections.includes(i.section));
  return own.find((i) => i.verdict === 'missing') ?? own.find((i) => i.verdict === 'wrong') ?? null;
}

function StageDetail({ stage, feedback: f, page }: { stage: InterviewPage['stages'][number] & { rating: Rating }; feedback: Feedback; page: InterviewPage }) {
  const own = f.stages.find((s) => s.key === stage.key);
  const check = checkpointOf(stage.sections, f.items ?? []);
  const checkSection = check ? page.sections.find((s) => s.key === check.section) : null;
  const columns = [own?.strengths.length ? 'w' : '', own?.improvements.length ? 'i' : '', check ? 'c' : ''].filter(Boolean).length;
  if (!columns) return null;
  return (
    <div id="ivf-stage" className={`ivf-stage ivf-r${stage.rating}`} style={{ '--ivf-cols': columns === 3 ? '1fr 1.5fr 1.2fr' : `repeat(${columns}, 1fr)` } as CSSProperties}>
      {own && own.strengths.length > 0 && (
        <div className="ivf-stage__col ivf-stage__col--well">
          <h3 className="ivf-label ivf-label--well">
            <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
              <path d="M1 5L4.5 8.5L11 1.5" />
            </svg>
            {t('feedback.well')}
          </h3>
          <ul>
            {own.strengths.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {own && own.improvements.length > 0 && (
        <div className="ivf-stage__col">
          <h3 className="ivf-label ivf-label--work">{t('feedback.work')}</h3>
          <ol className="ivf-numbered">
            {own.improvements.map((x, i) => (
              <li key={x}>
                <span aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                {x}
              </li>
            ))}
          </ol>
        </div>
      )}
      {check && (
        <div className="ivf-stage__col ivf-stage__col--check">
          <h3 className="ivf-label ivf-label--work">{t(check.verdict === 'wrong' ? 'feedback.checkWrong' : 'feedback.checkMissed')}</h3>
          <p className="ivf-check__title">{check.text}</p>
          {check.note && <p className="ivf-check__note">{check.note}</p>}
          {checkSection?.href && (
            <a className="ivf-check__read" href={checkSection.href}>
              {t('feedback.read', { title: checkSection.title })} <Arrow />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Practise({ id, steps, onRetry }: { id: string; steps: string[]; onRetry: () => void }) {
  // The room opens on the client (InterviewApp), so the ticks are read on the first render.
  const [done, setDone] = useState<number[]>(() => readPractised(id));
  const toggle = (i: number) => {
    const next = done.includes(i) ? done.filter((n) => n !== i) : [...done, i];
    setDone(next);
    try {
      localStorage.setItem(storageKey(id), JSON.stringify(next));
    } catch {
      // A private window: the ticks last for the page.
    }
  };
  return (
    <section className="ivf-card" aria-labelledby="ivf-practise">
      <div className="ivf-card__head">
        <h2 className="ivf-h2" id="ivf-practise">
          {t('feedback.next')}
        </h2>
        {steps.length > 0 && <span className="ivf-count">{`${done.filter((i) => i < steps.length).length} / ${steps.length}`}</span>}
      </div>
      {steps.length > 0 && (
        <ul className="ivf-practise">
          {steps.map((x, i) => (
            <li key={x}>
              <label>
                <input type="checkbox" checked={done.includes(i)} onChange={() => toggle(i)} />
                <span>{x}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ivf-retry" onClick={onRetry}>
        {t('feedback.retry')} <Arrow />
      </button>
    </section>
  );
}
