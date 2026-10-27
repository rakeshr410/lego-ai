import type { InterviewPage, PlaylistPage } from '../lib/interview.node';

// What the site's shell (lego/web) and this app's federated modules agree on (remote.vite.config.ts):
// each module exports CONTRACT and mount(element, props), which renders into an element the shell
// owns and returns a Mounted. The shell learns which module a page needs, its props and the
// remote's entry from GET /api/interview/page (lego/web src/lib/server/remote-pages.ts).
//
// Leaving: before the shell navigates away, it asks live(); with a session live it asks the reader
// ("End the interview?") and, if they do, awaits leave(), which ends the session, then unmount().
// The modules say what happens in them on the page's bus (lego/events): `interview.*`, `classroom.*`.

/** Bumped when a module's props or mount() change in a way an older shell can't take. */
export const CONTRACT = 1;

export type InterviewProps = { page: InterviewPage };
export type ClassroomProps = { kind: 'playlist'; page: PlaylistPage } | { kind: 'lesson'; page: InterviewPage };

/** A page the shell renders from this app: the module, its props, and the page's title and description. */
export type RemoteView =
  | { module: 'interview'; props: InterviewProps; title: string; description: string }
  | { module: 'classroom'; props: ClassroomProps; title: string; description: string };

export type Mounted = {
  /** Takes the module out of the shell's element. */
  unmount: () => void;
  /** Whether a session is live: leaving now would leave it open. */
  live: () => boolean;
  /** Ends the live session (no-op without one); resolves once the end is sent. */
  leave: () => Promise<void>;
};
