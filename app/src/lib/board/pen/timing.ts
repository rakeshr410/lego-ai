// The pen's tempo (docs/interview/coach-mode.md, phase 5), vendored from drawing-board (`src/pen/timing.ts`
// and the constants of `src/pen/animator.ts`, 2026). The "synced" values are the ones a pen keeping time
// with a voice uses: a little quicker, so a box is on the board before the next sentence is.

export const FRAME_MS = 33;
export const MOVE_MS = 450;
export const PAUSE_MS = 350;
export const ARROW_MS = 750;
export const SHAPE_MS = 900;
export const TEXT_MAX_MS = 2600;
export const CHAR_MS = 70;
export const SYNC_MOVE_MS = 280;
export const SYNC_SHAPE_MS = 520;
export const SYNC_CHAR_MS = 62;
/** The pen leaves the board this long after its last mark. */
export const REST_MS = 1800;
/** How wide a character is, as a share of the font size: the pen follows the words it writes, not the box they sit in. */
export const CHAR_W = 0.6;
