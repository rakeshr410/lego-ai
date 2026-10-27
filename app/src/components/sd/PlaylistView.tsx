import { useEffect, useState } from "react";
import type { PlaylistPage } from "../../lib/interview.node";
import { formatTwoDigits } from "../../i18n/format";
import t from "../../i18n/messages/interview";
import "../../styles/landing.css";

// A coaching playlist's page (docs/coaching.md), the classroom's landing for a system (design 19a): what it
// designs and its lessons on the left, each a lesson on its own (/coach/<playlist>/<lesson>); the full class on
// the right, with the lesson the reader left running.

const VOICE_BUILD = import.meta.env.PUBLIC_INTERVIEW_VOICE_ENABLED === "true";

type Status = {
  signedIn: boolean;
  current: { lesson: string; minutes: number } | null;
  finished: string[];
};

/** Where the reader is in the playlist; null until known, or when it can't be asked. */
function usePlaylistStatus(slug: string): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/interview/playlist?slug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => live && setStatus(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug]);
  return status;
}

export default function PlaylistView({ page }: { page: PlaylistPage }) {
  const { landing, lessons } = page;
  const status = usePlaylistStatus(page.slug);
  const minutes = lessons.reduce((n, l) => n + l.minutes, 0);
  const first = lessons[0];
  const paused = status?.current
    ? lessons.findIndex((l) => l.slug === status.current!.lesson)
    : -1;
  const finished = new Set(status?.finished ?? []);
  return (
    <div className="lp">
      <main className="lp-in" id="content" tabIndex={-1}>
        <div className="lp-main">
          <div className="lp-head">
            <p className="lp-kicker">
              {t("playlist.kicker", { name: landing.name })}
              <span className="lp-beta">{t("beta")}</span>
            </p>
            <h1 className="lp-title">
              {t("playlist.title", { subject: landing.subject })}{" "}
              <span>{t("playlist.title.with")}</span>
            </h1>
            <p className="lp-lede">
              {t(VOICE_BUILD ? "playlist.lede.voice" : "playlist.lede", {
                reach: landing.reach ?? t("playlist.lede.end"),
              })}
            </p>
          </div>

          <section className="lp-list" aria-labelledby="lp-lessons">
            <div className="lp-list__head">
              <h2 className="lp-label" id="lp-lessons">
                {t("playlist.lessons")}
              </h2>
            </div>
            <ol className="lp-rows">
              {lessons.map((l, i) => (
                <li key={l.slug}>
                  <a className="lp-row" href={l.href}>
                    <span className="lp-row__n lp-row__n--accent">
                      {formatTwoDigits(i + 1)}
                    </span>
                    <span className="lp-row__title">
                      {l.short}
                      {finished.has(l.slug) && (
                        <span className="lp-row__done">
                          {t("playlist.lesson.done")}
                        </span>
                      )}
                    </span>
                    <span className="lp-row__min">
                      {t("playlist.lesson.minutes", { minutes: l.minutes })}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </section>

          {page.interview && (
            <div className="lp-foot">
              <span className="lp-foot__gap" />
              <p className="lp-other">
                {t.rich("playlist.interview", {
                  link: (text, key) => (
                    <a key={key} className="lp-link" href={page.interview!}>
                      {text}
                    </a>
                  ),
                })}
              </p>
            </div>
          )}
        </div>

        <aside className="lp-card" aria-labelledby="lp-start">
          <div className="lp-card__head">
            <span className="lp-card__label">{t("playlist.full")}</span>
            <h2 className="lp-card__title" id="lp-start">
              {t("playlist.title", { subject: landing.subject })}
            </h2>
            <span className="lp-card__meta">
              {t(
                VOICE_BUILD ? "playlist.full.meta.voice" : "playlist.full.meta",
                { count: lessons.length, minutes },
              )}
            </span>
          </div>
          <div className="lp-card__body">
            <p className="lp-card__text">
              {t(
                VOICE_BUILD ? "playlist.full.text.voice" : "playlist.full.text",
              )}
            </p>
            {first && (
              <a className="lp-start" href={first.href}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path d="M3.5 2l8 5-8 5z" fill="currentColor" />
                </svg>
                {t("playlist.start")}
              </a>
            )}
            <p className="lp-hint">{t("playlist.pick")}</p>
          </div>
          {paused >= 0 && (
            <div className="lp-card__foot">
              <span>
                {t("playlist.paused", {
                  n: formatTwoDigits(paused + 1),
                  minutes: status!.current!.minutes,
                })}
              </span>
              <a href={lessons[paused].href}>{t("playlist.resume")}</a>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
