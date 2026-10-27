import { withArticle } from "../../subject";
import type { Playlist } from "./schema";

// A playlist page's words (components/sd/PlaylistView.tsx): what is designed, and where the lessons end. A
// playlist's `landing` says what its title can't; else the subject comes from the title.

export type PlaylistLanding = {
  /** What follows "Design" in the headline: "a job scheduler". */
  subject: string;
  /** The same without its article, for the kicker: "job scheduler". */
  name: string;
  /** Where the lessons end, for the lede ("the polling race"), or null. */
  reach: string | null;
};

/** The title's subject ("The job scheduler interview" -> "a job scheduler"), or the title as it is. */
function subjectOf(title: string): string {
  const m = /^the (.+?) interview$/i.exec(title.trim());
  return m ? withArticle(m[1]) : title;
}

/** A lesson's title without the playlist's lead ("The job scheduler interview: retries" -> "Retries"). */
export function shortTitle(title: string): string {
  const at = title.indexOf(": ");
  const rest = at > 0 ? title.slice(at + 2) : title;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function playlistLanding(pl: Playlist): PlaylistLanding {
  const subject = pl.landing?.subject ?? subjectOf(pl.title);
  return {
    subject,
    name: subject.replace(/^(?:a|an|the)\s+/i, ""),
    reach: pl.landing?.reach ?? null,
  };
}
