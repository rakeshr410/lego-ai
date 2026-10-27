// The learner's questions toggle in a lesson (InterviewRoom.tsx), remembered in this browser: the next lesson
// starts the way they left the last one. A convenience only: each session keeps its own (Session.coachQuiet).
const KEY = 'iv-coach-questions';

/** Whether lessons start as a discussion (the coach asks things), as last chosen here; true when nothing was. */
export function rememberedQuestions(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function rememberQuestions(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // Private windows and blocked storage: the next lesson starts as a discussion.
  }
}
