#!/usr/bin/env node
/**
 * Pauses or resumes mock interviews for every web instance at once, without a redeploy, and shows
 * their state. The flag lives in the shared store (Redis) and overrides INTERVIEW_ENABLED; web
 * instances pick up a change within about 5 seconds. Ask's switch (scripts/ask-switch.mjs) stops
 * interviews too: it guards every Anthropic call.
 *
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs status
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs off "cost review"
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs on
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs clear    # back to INTERVIEW_ENABLED
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs voice off "vendor incident"   # the voice part only
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs voice on | clear | status
 *
 * `voice` pauses only voice sessions (new ones refuse; running pipelines end at their next
 * heartbeat and the sessions go on in text); text interviews are unaffected.
 *
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs allow list
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs allow add ada@example.com bob@example.com
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs allow remove ada@example.com
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs allow clear
 *
 * `allow` edits the early-access allowlist (src/lib/server/interview/access.ts): while it, or
 * INTERVIEW_ALLOWLIST, names anyone, only those readers and staff may start; empty, everyone may.
 * Instances pick up a change within about 5 seconds.
 *
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs topups <readerDocumentId>
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs topups <readerDocumentId> add 2
 *   REDIS_URL=rediss://... node scripts/interview-switch.mjs topups <readerDocumentId> remove 1
 *
 * `topups` shows or changes a reader's purchased voice sessions (docs/README.md, "Voice
 * quota rule"): a whole voice session past the month's quota spends one. The reader is named by the
 * CMS document id the web uses as its reader id. This is the grant path until a purchase flow
 * exists; the balance never goes below zero.
 *
 * Keys and prefix are kept in sync with src/lib/server/interview/sessions.ts and store.ts.
 */
import { Redis } from 'ioredis';

const PREFIX = 'bp:';
const SWITCH = `${PREFIX}interview:enabled`;
const REASON = `${PREFIX}interview:enabled:reason`;
const spendKey = (day) => `${PREFIX}interview:spend:${day}`;
const VOICE_SWITCH = `${PREFIX}interview:voice:enabled`;
const VOICE_REASON = `${PREFIX}interview:voice:enabled:reason`;
const voiceSpendKey = (day) => `${PREFIX}interview:voice-spend:${day}`;
const ALLOWLIST = `${PREFIX}interview:allowlist`;
const topupsKey = (readerId) => `${PREFIX}interview:voice:topups:${readerId}`;
const TOPUPS_TTL_S = 366 * 24 * 60 * 60;

const args = process.argv.slice(2);
const voice = args[0] === 'voice';
if (voice) args.shift();
const allow = args[0] === 'allow';
if (allow) args.shift();
const topups = args[0] === 'topups';
if (topups) args.shift();
const topupReader = topups ? args.shift() : null;
const [cmd = topups ? 'show' : 'status', ...rest] = args;
const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL is not set. Without Redis (single dev server) set INTERVIEW_ENABLED=false and restart instead.');
  process.exit(2);
}
const USAGE =
  'Usage: node scripts/interview-switch.mjs [voice] on | off [reason] | clear | status\n' +
  '       node scripts/interview-switch.mjs allow list | add <email...> | remove <email...> | clear\n' +
  '       node scripts/interview-switch.mjs topups <readerDocumentId> [add <n> | remove <n>]';
const topupCount = Number(rest[0]);
if (topups ? !topupReader || !/^[A-Za-z0-9_-]{1,64}$/.test(topupReader) || !['show', 'add', 'remove'].includes(cmd) || (cmd !== 'show' && !(Number.isInteger(topupCount) && topupCount > 0)) : allow ? !['list', 'add', 'remove', 'clear'].includes(cmd) : !['on', 'off', 'clear', 'status'].includes(cmd)) {
  console.error(USAGE);
  process.exit(2);
}
const emails = rest.map((e) => e.trim().toLowerCase()).filter(Boolean);
if (allow && (cmd === 'add' || cmd === 'remove') && (!emails.length || emails.some((e) => !e.includes('@')))) {
  console.error(USAGE);
  process.exit(2);
}
const switchKey = voice ? VOICE_SWITCH : SWITCH;
const reasonKey = voice ? VOICE_REASON : REASON;

const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 5_000, lazyConnect: true, retryStrategy: () => null });
redis.on('error', () => {}); // reported by the command that fails
const who = process.env.USER ?? 'operator';
const now = new Date().toISOString();

try {
  await redis.connect();
  if (topups) {
    const key = topupsKey(topupReader);
    if (cmd !== 'show') {
      // Never below zero, as the web's helper keeps it.
      const next = Number(await redis.incrbyfloat(key, cmd === 'add' ? topupCount : -topupCount));
      if (next < 0) await redis.incrbyfloat(key, -next);
      await redis.expire(key, TOPUPS_TTL_S);
    }
    const balance = Math.max(0, Math.floor(Number(await redis.get(key)) || 0));
    console.log(`Voice top-up sessions for reader ${topupReader}: ${balance}`);
  } else if (allow) {
    const current = JSON.parse((await redis.get(ALLOWLIST)) ?? '[]');
    let next = current;
    if (cmd === 'add') next = [...new Set([...current, ...emails])].sort();
    else if (cmd === 'remove') next = current.filter((e) => !emails.includes(e));
    else if (cmd === 'clear') next = [];
    if (cmd !== 'list') await redis.set(ALLOWLIST, JSON.stringify(next));
    console.log(next.length ? `Early-access allowlist (${next.length}, plus INTERVIEW_ALLOWLIST and staff):\n  ${next.join('\n  ')}` : 'Early-access allowlist: empty (everyone signed in may start, unless INTERVIEW_ALLOWLIST is set).');
  } else if (cmd === 'on' || cmd === 'off') {
    await redis.set(switchKey, cmd);
    await redis.set(reasonKey, `${now} ${who}: ${rest.join(' ') || (cmd === 'on' ? 'turned on' : 'turned off')}`);
  } else if (cmd === 'clear') {
    await redis.del(switchKey, reasonKey);
  }
  const day = now.slice(0, 10);
  const [flag, reason, spent, voiceFlag, voiceReason, voiceSpent] = await Promise.all([
    redis.get(SWITCH),
    redis.get(REASON),
    redis.get(spendKey(day)),
    redis.get(VOICE_SWITCH),
    redis.get(VOICE_REASON),
    redis.get(voiceSpendKey(day)),
  ]);
  const state = flag === 'on' ? 'ON (store flag)' : flag === 'off' ? 'OFF (store flag)' : 'not set (web instances use INTERVIEW_ENABLED, default on)';
  console.log(`Mock interviews: ${state}`);
  if (reason) console.log(`Last change: ${reason}`);
  console.log(`Estimated interview spend today (UTC): $${((Number(spent) || 0) / 1e6).toFixed(4)} (breaker: INTERVIEW_DAILY_BUDGET_USD)`);
  const voiceState = voiceFlag === 'on' ? 'ON (store flag)' : voiceFlag === 'off' ? 'OFF (store flag)' : 'not set (web instances use INTERVIEW_VOICE_ENABLED, default on)';
  console.log(`Voice interviews: ${voiceState}`);
  if (voiceReason) console.log(`Last change: ${voiceReason}`);
  console.log(`Estimated voice spend today (UTC): $${((Number(voiceSpent) || 0) / 1e6).toFixed(4)} (breaker: INTERVIEW_VOICE_DAILY_BUDGET_USD)`);
} catch (err) {
  console.error(`Could not reach Redis: ${err.message}`);
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
