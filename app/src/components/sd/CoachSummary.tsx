import { useState, type ReactNode } from 'react';
import type { InterviewPage } from '../../lib/interview.node';
import t from '../../i18n/messages/interview';
import type { SessionView } from '../../pages/api/interview/index';
import CoachRail from './CoachRail';
import '../../styles/interview-feedback.css';
import '../../styles/interview-coach.css';

// A coach lesson's end screen (docs/interview/coach-mode.md): what the learner understood, what is
// shaky and what the lesson never reached, by section, from the coach's ledger; then the way to the
// mock interview on the same material. No grader runs: the statuses are the lesson's own.

type Props = {
  page: InterviewPage;
  session: SessionView;
  transcript: ReactNode;
  deleting: boolean;
  error: string;
  onDelete: () => void;
  /** Back to the page, where another lesson starts. */
  onRetry: () => void;
};

export default function CoachSummary({ page, session, transcript, deleting, error, onDelete, onRetry }: Props) {
  const [showTranscript, setShowTranscript] = useState(false);
  const lesson = session.lesson;
  const kicker = [t('coach.summary.kicker'), page.system.name, session.scope ? t('crumb.drill') : null].filter(Boolean).join(' · ');
  const interviewHref = `/systems/${page.system.slug}/interview${session.scope ? `?topic=${encodeURIComponent(session.scope.topic)}${session.scope.section ? `&section=${encodeURIComponent(session.scope.section)}` : ''}` : ''}`;

  return (
    <main className="ivf" id="content" tabIndex={-1}>
      <div className="ivf-head">
        <div className="ivf-head__text">
          <span className="ivf-kicker">{kicker}</span>
          <h1 className="ivf-title">{t('coach.summary.title')}</h1>
          <span className="ivf-sub">{`${page.title} · ${t('coach.summary.length', { minutes: session.plannedMinutes })}`}</span>
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
        {lesson && (
          <div className="ivk-summary">
            <section className="ivf-verdict ivk-tally" aria-label={t('coach.summary.title')}>
              <div className="ivk-tally__row">
                <span className="ivk-tally__n is-understood">{lesson.understood}</span>
                <span>{t('coach.summary.understood', { count: lesson.understood })}</span>
              </div>
              <div className="ivk-tally__row">
                <span className="ivk-tally__n is-shaky">{lesson.shaky}</span>
                <span>{t('coach.summary.shaky', { count: lesson.shaky })}</span>
              </div>
              <div className="ivk-tally__row">
                <span className="ivk-tally__n is-left">{lesson.left}</span>
                <span>{t('coach.summary.left', { count: lesson.left })}</span>
              </div>
              <div className="ivk-tally__next">
                <a className="ivf-btn ivk-go" href={interviewHref}>
                  {t('coach.summary.interview')}
                </a>
                <p className="ivk-tally__note">{t('coach.summary.interview.note')}</p>
                <button type="button" className="ivk-link" onClick={onRetry}>
                  {t('coach.summary.again')}
                </button>
              </div>
            </section>
            <section className="ivf-card" aria-labelledby="ivk-by-section">
              <h2 className="ivf-h2" id="ivk-by-section">
                {t('coach.summary.bySection')}
              </h2>
              <CoachRail lesson={lesson} stageIndex={session.stageIndex} expanded />
            </section>
          </div>
        )}
        <footer className="ivf-foot">
          <span>{t('coach.summary.caveat')}</span>
          <span>{t('room.kept')}</span>
        </footer>
      </div>
    </main>
  );
}
