// The one helper the interview's prompts share with the main site's Ask tutor
// (lego/web/src/lib/server/tutor.ts); Ask itself is not part of this app.

/** Escapes text placed inside the prompt's XML-style tags so it can't close or open one. */
export const escapeTagged = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
