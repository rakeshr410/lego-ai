// The pen's tempo (docs/coach-mode.md, phase 5), vendored from drawing-board (`src/pen/timing.ts`
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
/** How long after a voice cue arrives its audio is heard (the call's jitter buffer and the way to the speaker). */
export const VOICE_PLAYOUT_MS = 150;
/** A mark waits this long for its voice cue before the pen draws it at its own pace. */
export const CUE_WAIT_MS = 30_000;
/** A hover (the voice talking about what is on the board): the move to it, how slowly it drifts along the words (ms a pixel), how long it stays after the last word. */
export const HOVER_MOVE_MS = 520;
export const HOVER_PX_MS = 9;
export const HOVER_REST_MS = 4000;
