import type { PlaylistPage } from '../../lib/interview.node';
import t from '../../i18n/messages/interview';
import '../../styles/interview.css';
import '../../styles/playlist.css';

/** A coaching playlist (docs/coaching.md): its lessons in order, each a whiteboard lesson with the coach (/coach/<playlist>/<lesson>). */
export default function PlaylistView({ page }: { page: PlaylistPage }) {
  return (
    <div className="iv">
      <main className="ivl pl" id="content" tabIndex={-1}>
        <section className="ivl-card ivl-hero">
          <div className="ivl-hero__text">
            <span className="ivl-kicker">
              {t('playlist.kicker')}
              <span className="ivl-beta">{t('beta')}</span>
            </span>
            <h1 className="ivl-title">{page.title}</h1>
            <p className="ivl-lede">{page.summary}</p>
          </div>
        </section>
        <section className="ivl-card" aria-labelledby="pl-lessons">
          <div className="ivl-card__intro">
            <h2 className="ivl-h2" id="pl-lessons">
              {t('playlist.lessons')}
            </h2>
            <p className="ivl-small">{t('playlist.lessons.note')}</p>
          </div>
          <ol className="pl-list">
            {page.lessons.map((l, i) => (
              <li className="pl-lesson" key={l.slug}>
                <span className="pl-n" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <a className="pl-lesson__body" href={l.href}>
                  <span className="pl-lesson__head">
                    <span className="pl-lesson__title">{l.title}</span>
                    <span className="ivl-mono">{t('playlist.lesson.minutes', { minutes: l.minutes })}</span>
                  </span>
                  <span className="ivl-small">{l.summary}</span>
                  <span className="ivl-mono ivl-mono--faint">{l.parts.join(' · ')}</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
        <section className="ivl-card">
          <h2 className="ivl-h3">{t('playlist.outline')}</h2>
          <p className="ivl-small">{page.outline}</p>
        </section>
      </main>
    </div>
  );
}
