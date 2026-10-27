// What a page designs, as said after a verb ("Design a job scheduler", "Can you explain Amazon"): a/an by how the
// word starts when said, no article before a name or a mass noun ("OTT streaming", "proximity search").

/** "a" or "an", by how the word starts when said ("an OTT", "a URL", "an e-commerce"). */
export const article = (word: string) =>
  /^(?:[aeio]|u(?!rl|ni|s[eu]))/i.test(word) ||
  /^[AEFHILMNORSX](?:[A-Z]|$)/.test(word)
    ? "an"
    : "a";

/** Names said without an article: activities, plurals and fields ("ride sharing", "load balancers", "fraud detection"). */
const MASS = /(?:ing|s|ion|search|storage|delivery|support|commerce|sub)$/i;

/** "job scheduler" -> "a job scheduler", "URL shortener" -> "a URL shortener", "OTT streaming" -> "OTT streaming". */
export function withArticle(name: string): string {
  return MASS.test(name) ? name : `${article(name)} ${name}`;
}

/**
 * A system's name as said in a sentence: "Job scheduler" -> "a job scheduler", "URL shortener" -> "a URL shortener",
 * "Amazon" -> "Amazon". `title` is its interview's ("Design Amazon"): without "a"/"an" the name is a product's.
 */
export function systemSubject(name: string, title: string): string {
  const m = /^design (?:(a|an) )?(.+)$/i.exec(title.trim());
  // A product's ("Design Amazon"), or one the title says in its own words ("Design a photo-sharing web app").
  if (m && (!m[1] || !m[2].toLowerCase().includes(name.toLowerCase())))
    return m[1] ? `${m[1]} ${m[2]}` : m[2];
  const said = /^[A-Z]{2}/.test(name)
    ? name
    : name.charAt(0).toLowerCase() + name.slice(1);
  return withArticle(said);
}
