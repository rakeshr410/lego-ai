import { useEffect, useId, useState, type ReactNode } from 'react';
import { rememberedQuestions } from '../../lib/coach-pref';
import type { InterviewPage } from '../../lib/interview.node';
import type { InterviewStatus, SessionView, VoiceJoin, VoiceStatus } from '../../pages/api/interview/index';
import { formatDate } from '../../i18n/format';
import t from '../../i18n/messages/interview';
import InterviewLanding from './InterviewLanding';
import InterviewRoom from './InterviewRoom';

// The mock interview page's island (P3-11): the landing page with the session card's controls
// (sign in, consent, start: with voice on Pro in a voice build, typed otherwise; resume, past sessions),
// and the room once a session is open.
// Everything it knows about the reader comes from /api/interview after load; the prerendered HTML
// is the same for everyone.

/** The reader's credits (lego-ledger): null when sessions count against the month's allowance instead. */
type Credits = { balance: { total: number; expiresAt: string }; rates: Record<string, number>; minMinutes: number };

type Overview = {
  signedIn: boolean;
  status: InterviewStatus;
  voice: VoiceStatus;
  credits?: Credits | null;
  current: SessionView | null;
  past: { id: string; startedAt: string; status: SessionView['status']; rated: boolean }[];
  /** A drill's page projection (the prerendered page is the system's); null on the whole interview. */
  page: InterviewPage | null;
};

type Props = { page: InterviewPage };

/** The drill in the page's query (docs/README.md, "Drills"): ?topic=<slug>[&section=<key>], or null for the whole interview. */
type Scope = { topic: string; section: string | null } | null;
const scopeFromQuery = (search: string): Scope => {
  const q = new URLSearchParams(search);
  const topic = q.get('topic');
  return topic ? { topic, section: q.get('section') || null } : null;
};
const scopeQuery = (scope: Scope) => (scope ? `&topic=${encodeURIComponent(scope.topic)}${scope.section ? `&section=${encodeURIComponent(scope.section)}` : ''}` : '');
/** A coach lesson (docs/coach-mode.md) when the page's query says ?kind=coach; the mock interview otherwise. */
type Kind = 'interview' | 'coach';
const kindFromQuery = (search: string): Kind => (new URLSearchParams(search).get('kind') === 'coach' ? 'coach' : 'interview');
const kindQuery = (kind: Kind) => (kind === 'coach' ? '&kind=coach' : '');
/** A playlist's lesson (docs/coaching.md): its page is its own, and the API is told which lesson. */
const lessonQuery = (page: InterviewPage) => (page.course ? `&lesson=${encodeURIComponent(page.course.lesson)}` : '');

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const day = (iso: string) => formatDate(iso, { day: 'numeric', month: 'short' });
// Voice is in the build or not (VoiceRoom.tsx and Daily's client ship only with it): a literal
// comparison, so Vite drops the other branch.
const VOICE_BUILD = import.meta.env.PUBLIC_INTERVIEW_VOICE_ENABLED === 'true';
type Mode = 'text' | 'voice';

/** The microphone, from a click, before a voice session starts; the stream is dropped at once. */
async function micPreflight(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

/** With credits: what a session here costs a minute, the least it costs to start, and the balance. */
function costOf(overview: Overview, scope: Scope, kind: Kind): { rate: number; needed: number; total: number } | null {
  const credits = overview.credits;
  if (!credits) return null;
  const mode = VOICE_BUILD && overview.voice.enabled ? 'voice' : 'text';
  const rate = credits.rates[`${kind === 'coach' ? 'coach' : scope ? 'drill' : 'interview'}:${mode}`] ?? 0;
  return { rate, needed: Math.max(rate * credits.minMinutes, 0.001), total: credits.balance.total };
}

const whole = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** What starting costs and what is left, for the start card's header; null when nothing can start. */
function usageOf(overview: Overview | null, scope: Scope, kind: Kind): string | null {
  if (!overview?.signedIn || overview.current || !overview.status.enabled) return null;
  const cost = costOf(overview, scope, kind);
  if (cost) return t('credits.usage', { rate: whole(cost.rate), total: whole(Math.floor(cost.total * 10) / 10) });
  const { status, voice } = overview;
  if (kind === 'coach') return t('coach.usage', { limit: status.coachLimit, remaining: Math.max(0, status.coachRemaining) });
  if (scope) return t('usage.drill', { limit: status.drillLimit, remaining: Math.max(0, status.drillsRemaining) });
  if (!VOICE_BUILD) return t('usage.text', { limit: status.limit, remaining: Math.max(0, status.remaining) });
  if (!voice.enabled || (voice.remaining <= 0 && voice.topups <= 0)) return null;
  const line = t('usage.voice', { limit: voice.limit, remaining: Math.max(0, voice.remaining) });
  return voice.topups > 0 ? `${line} ${t('voice.topups', { count: voice.topups })}` : line;
}

/** The reader's interview state on this system (and drill), or why it can't be had. */
async function fetchOverview(page: InterviewPage, scope: Scope, kind: Kind): Promise<{ overview: Overview } | { error: string }> {
  try {
    const r = await call(`/api/interview?system=${encodeURIComponent(page.system.slug)}${scopeQuery(scope)}${kindQuery(kind)}${lessonQuery(page)}`);
    if (r.ok) return { overview: r.data as Overview };
    return { error: (r.data as { error?: string }).error ?? t('load.failed') };
  } catch {
    return { error: t('load.offline') };
  }
}

export default function InterviewApp({ page: systemPage }: Props) {
  // The overview, with the drill the URL named when it was fetched (docs/README.md,
  // "Drills"): the HTML is the same for every scope, so the query is read once the island runs.
  const [overview, setOverview] = useState<(Overview & { scope: Scope; kind: Kind }) | null>(null);
  const [loadError, setLoadError] = useState('');
  const [session, setSession] = useState<SessionView | null>(null);
  const [join, setJoin] = useState<VoiceJoin | null>(null);
  // Bumped to load the overview again (after leaving the room).
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    // A lesson's page is the coach's, on no drill.
    const scope = systemPage.course ? null : scopeFromQuery(window.location.search);
    const kind = systemPage.course ? 'coach' : kindFromQuery(window.location.search);
    void fetchOverview(systemPage, scope, kind).then((r) => {
      if (!alive) return;
      if ('overview' in r) {
        setLoadError('');
        setOverview({ ...r.overview, scope, kind });
      } else setLoadError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [systemPage, version]);

  const scope = overview?.scope ?? null;
  const kind: Kind = overview?.kind ?? (systemPage.course ? 'coach' : 'interview');
  // On a drill, the drill's projection; the system's page until the overview loads (and always on the whole interview).
  const page = (scope && overview?.page) || systemPage;

  if (session) {
    return (
      <InterviewRoom
        page={page}
        initial={session}
        join={join}
        onExit={() => {
          setSession(null);
          setJoin(null);
          setVersion((v) => v + 1);
        }}
      />
    );
  }
  const open = (s: SessionView, j: VoiceJoin | null = null) => {
    setJoin(j);
    setSession(s);
    // The room replaces the landing in place: it opens at its top, not where the start button had the page scrolled.
    window.scrollTo({ top: 0 });
  };
  // A concept system's page: drills only, nothing to start here. (A drill the server does not
  // have, a stale link: the overview's error says so in the card.)
  const pick = !systemPage.full && (overview ? !scope : !loadError);
  return (
    <InterviewLanding
      page={page}
      scope={scope}
      kind={kind}
      systemFull={systemPage.full}
      usage={pick ? null : usageOf(overview, scope, kind)}
      action={
        pick ? (
          <div className="iv-session__note" role="status">
            {t('drills.pick')}
          </div>
        ) : (
          <SessionCard page={page} scope={scope} kind={kind} overview={overview} loadError={loadError} onOpen={open} />
        )
      }
    />
  );
}

// The consent a reader gave, remembered in this browser by its version: the next lesson of a playlist shows the
// same terms already agreed to (a new version asks again). A convenience only: the server checks the version.
const consentKey = (version: string) => `iv-consent:${version}`;
function agreedBefore(version: string | undefined): boolean {
  if (!version) return false;
  try {
    return localStorage.getItem(consentKey(version)) === '1';
  } catch {
    return false;
  }
}
// What the coach calls the learner, remembered in this browser for the next lesson (the server checks it).
const NAME_KEY = 'iv-name';
function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberName(name: string) {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    // Private windows and blocked storage: the field is empty again next time.
  }
}

function rememberConsent(version: string) {
  try {
    localStorage.setItem(consentKey(version), '1');
  } catch {
    // Private windows and blocked storage: the box is ticked again next time.
  }
}

function SessionCard({ page, scope, kind, overview, loadError, onOpen }: { page: InterviewPage; scope: Scope; kind: Kind; overview: Overview | null; loadError: string; onOpen: (s: SessionView, join?: VoiceJoin | null) => void }) {
  // A voice build starts voice sessions of either kind (a lesson is spoken by the coach, phase 2 of coach-mode.md).
  const coach = kind === 'coach';
  const voiceBuild = VOICE_BUILD;
  // The typed interview's consent step (a build without voice; voice shows its consent in the card).
  const [consenting, setConsenting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [audioOptIn, setAudioOptIn] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const consentId = useId();
  const consentVersion = overview ? (voiceBuild ? overview.voice?.consentVersion : overview.status.consentVersion) : undefined;
  useEffect(() => {
    if (agreedBefore(consentVersion)) setAgreed(true);
  }, [consentVersion]);
  useEffect(() => setName(rememberedName()), []);

  const open = async (id: string) => {
    setBusy(true);
    setError('');
    const r = await call(`/api/interview/${id}`).catch(() => null);
    setBusy(false);
    if (r?.ok) onOpen((r.data as { session: SessionView }).session);
    else setError((r?.data as { error?: string } | undefined)?.error ?? t('open.failed'));
  };

  const start = async (mode: Mode) => {
    if (!overview) return;
    setBusy(true);
    setError('');
    if (mode === 'voice' && !(await micPreflight())) {
      setBusy(false);
      setError(t('voice.micDenied'));
      return;
    }
    const drill = page.course ? { lesson: page.course.lesson } : scope ? { topic: scope.topic, section: scope.section ?? undefined } : {};
    const body =
      mode === 'voice'
        ? { system: page.system.slug, ...drill, mode: 'voice', consent: overview.voice.consentVersion, audioOptIn, ...(coach ? { kind: 'coach', name: name.trim(), questions: rememberedQuestions() } : {}) }
        : { system: page.system.slug, ...drill, consent: overview.status.consentVersion, ...(coach ? { kind: 'coach', name: name.trim(), questions: rememberedQuestions() } : {}) };
    const r = await call('/api/interview', 'POST', body).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      const data = r.data as { session: SessionView; join?: VoiceJoin };
      rememberConsent(body.consent);
      if (coach) rememberName(name.trim());
      onOpen(data.session, data.join ?? null);
    } else setError((r?.data as { error?: string } | undefined)?.error ?? t(coach ? 'coach.start.failed' : 'start.failed'));
  };

  const note = (text: ReactNode) => (
    <div className="iv-session__note" role="status">
      {text}
    </div>
  );

  // A voice build starts voice sessions only; a build without voice keeps the typed interview.
  const startLabel = coach ? (voiceBuild ? t('coach.start.voice') : t('coach.start')) : voiceBuild ? t('start.voice') : scope ? t('start.drill') : t('start');
  if (loadError) {
    return (
      <>
        <button type="button" className="iv-start" disabled>
          {startLabel} <span>→</span>
        </button>
        {note(loadError)}
      </>
    );
  }
  if (!overview) {
    return (
      <button type="button" className="iv-start" disabled aria-busy="true">
        {t('checking')} <span>→</span>
      </button>
    );
  }
  const { status, voice, current, past } = overview;
  if (!overview.signedIn) {
    const query = `${scopeQuery(scope)}${kindQuery(kind)}`;
    const next = page.course?.href ?? `/systems/${page.system.slug}/interview${query ? `?${query.slice(1)}` : ''}`;
    return (
      <>
        <a className="iv-start" href={`/signin?next=${encodeURIComponent(next)}`}>
          {t('signIn')} <span>→</span>
        </a>
        {note(t('signIn.note'))}
      </>
    );
  }

  const pastList = past.length ? (
    <div className="ivs-past">
      <div className="iv-label">{t('past')}</div>
      <ul>
        {past.map((p) => (
          <li key={p.id}>
            <button type="button" className="ivs-link" onClick={() => void open(p.id)} disabled={busy}>
              {t(p.status === 'finished' ? (p.rated ? 'past.feedback' : 'past.transcript') : 'past.view', { day: day(p.startedAt) })}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  if (current) {
    return (
      <>
        <button type="button" className="iv-start" onClick={() => onOpen(current)}>
          {t('resume')} <span>→</span>
        </button>
        {note(t(coach ? 'coach.resume.note' : 'resume.note', { day: day(current.startedAt) }))}
        {error && note(error)}
        {pastList}
      </>
    );
  }

  const cost = costOf(overview, scope, kind);
  const unavailable = !status.enabled
    ? status.reason === 'budget'
      ? t('unavailable.budget')
      : status.reason === 'disabled'
        ? t('unavailable.disabled')
        : status.reason === 'access'
          ? t('unavailable.access')
          : t('unavailable.other')
    : cost
      ? cost.total < cost.needed
        ? (t.rich('credits.short', { needed: whole(cost.needed), total: whole(Math.floor(cost.total * 10) / 10), day: day(overview.credits!.balance.expiresAt), link: (text, key) => <a key={key} href="/pricing#credits">{text}</a> }) as ReactNode)
        : ''
    : coach
      ? status.coachRemaining <= 0
        ? t('coach.unavailable.used', { limit: status.coachLimit, day: day(status.resetsAt) })
        : ''
      : scope
        ? status.drillsRemaining <= 0
          ? t('unavailable.drillsUsed', { limit: status.drillLimit, day: day(status.resetsAt) })
          : ''
        : !voiceBuild && status.remaining <= 0
          ? t('unavailable.used', { limit: status.limit, day: day(status.resetsAt) })
          : '';
  if (unavailable) {
    return (
      <>
        <button type="button" className="iv-start" disabled>
          {startLabel} <span>→</span>
        </button>
        {note(unavailable)}
        {pastList}
      </>
    );
  }

  // Voice (Pro, a voice build): its button and why it is off. Purchased
  // top-ups carry a whole session past the month's quota (not a drill).
  const topups = !scope && voice.topups > 0 ? ` ${t('voice.topups', { count: voice.topups })}` : '';
  const voiceNote = !voiceBuild
    ? null
    : !voice.enabled
      ? voice.reason === 'plan'
        ? (t.rich('voice.pro', { link: (text, key) => <a key={key} href="/pricing">{text}</a> }) as ReactNode)
        : t('voice.paused')
      : !cost && voice.remaining <= 0
        ? `${t('voice.used', { limit: voice.limit, day: day(voice.resetsAt) })}${topups}`
        : null;
  // A drill in voice counts a drill and its minutes, not a voice session: only the minutes can run out.
  const voiceOk = voiceBuild && voice.enabled && (cost ? true : scope ? voice.minutesLeft >= page.minutes : voice.remaining > 0 || voice.topups > 0);

  if (voiceBuild && !voiceOk) {
    return (
      <>
        <button type="button" className="iv-start" disabled>
          {startLabel} <span>→</span>
        </button>
        {voiceNote && note(voiceNote)}
        {pastList}
      </>
    );
  }
  if (voiceBuild) {
    // Design 16a: the consent is the card (what happens, the two boxes, then the start).
    return (
      <>
        <div className="ivl-label" id={`${consentId}-title`}>
          {t('consent.title')}
        </div>
        <ul className="ivl-bullets" aria-labelledby={`${consentId}-title`}>
          <li>{t(coach ? 'coach.consent.voice.ai' : 'consent.voice.ai')}</li>
          <li>{t('consent.voice.mic')}</li>
          <li>{t('consent.keep', { days: status.retentionDays })}</li>
          <li>{t('consent.private')}</li>
          {scope && <li>{t('consent.voice.drill', { limit: status.drillLimit, minutes: page.minutes })}</li>}
        </ul>
        <p className="ivl-more">{t.rich('consent.more', { link: (text, key) => <a key={key} href="/legal/privacy">{text}</a> })}</p>
        <div className="ivl-agree">
          {coach && (
            <label className="ivl-name">
              <span>{t('coach.name.label')}</span>
              <input type="text" value={name} maxLength={30} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
              <small>{t('coach.name.hint')}</small>
            </label>
          )}
          <label className="ivl-check">
            <input type="checkbox" checked={audioOptIn} onChange={(e) => setAudioOptIn(e.target.checked)} />
            <span>{t('consent.voice.optIn')}</span>
          </label>
          <label className="ivl-check ivl-check--strong">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{t('consent.agree')}</span>
          </label>
          <button type="button" className="iv-start iv-start--go" disabled={!agreed || busy} aria-busy={busy} onClick={() => void start('voice')}>
            {busy ? t('consent.starting') : t('start.voiceCheck')} <span>→</span>
          </button>
          {error && (
            <div className="ivl-error" role="alert">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="7" cy="7" r="6" />
                <path d="M7 3.8V7.6" />
                <circle cx="7" cy="10" r=".9" className="is-dot" />
              </svg>
              <span>{error}</span>
            </div>
          )}
        </div>
        {pastList}
      </>
    );
  }
  if (!consenting) {
    return (
      <>
        <button type="button" className="iv-start" onClick={() => setConsenting(true)}>
          {startLabel} <span>→</span>
        </button>
        {pastList}
      </>
    );
  }
  // A build without voice: the typed interview's consent, a step after its button.
  return (
    <div className="ivs-consent">
      <div className="iv-label" id={`${consentId}-title`}>
        {t('consent.title')}
      </div>
      <ul aria-labelledby={`${consentId}-title`}>
        <li>{t(coach ? 'coach.consent.ai' : 'consent.ai')}</li>
        <li>{t('consent.text')}</li>
        <li>{t('consent.keep', { days: status.retentionDays })}</li>
        <li>{t('consent.private')}</li>
        <li>{coach ? t('coach.consent.uses', { limit: status.coachLimit }) : scope ? t('consent.drill', { limit: status.drillLimit }) : t('consent.uses', { limit: status.limit })}</li>
      </ul>
      <p className="ivs-consent__more">
        {t.rich('consent.more', { link: (text, key) => <a key={key} href="/legal/privacy">{text}</a> })}
      </p>
      <label className="ivs-consent__agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>{t('consent.agree')}</span>
      </label>
      <button type="button" className="iv-start" disabled={!agreed || busy} aria-busy={busy} onClick={() => void start('text')}>
        {busy ? t('consent.starting') : t('consent.start')} <span>→</span>
      </button>
      <button type="button" className="ivs-link" onClick={() => setConsenting(false)} disabled={busy}>
        {t('consent.back')}
      </button>
      {error && note(error)}
    </div>
  );
}
