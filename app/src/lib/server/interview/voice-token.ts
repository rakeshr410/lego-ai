import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The attach token (design section 6): the web tier mints one when it asks the voice service to
// run a session, and the service presents it back on `attach` so a pipeline can only take the
// session it was started for, within a minute. The labs token format (labs/runner/src/token.ts,
// web/src/lib/server/labs-token.ts): v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>, with
// the voice service's own secret. The voice service verifies nothing itself: it hands the token
// back, and the web tier checks it here.

export type VoiceClaims = {
  /** The reader (the Strapi documentId). */
  uid: string;
  /** The session the token opens. */
  sid: string;
  /** The plan's hash when the session started: a pipeline built for another plan is refused. */
  planHash: string;
  consentVersion: string;
  /** One use: an attach token replayed after its first attach is refused. */
  jti: string;
  iat: number;
  exp: number;
};

export const VOICE_TOKEN_TTL_SEC = 60;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(`v1.${body}`).digest();

export function mintVoiceToken(secret: string, claims: Omit<VoiceClaims, 'iat' | 'exp' | 'jti'>, nowMs = Date.now(), ttlSec = VOICE_TOKEN_TTL_SEC): string {
  if (!secret) throw new Error('INTERVIEW_VOICE_SECRET is not set');
  const iat = Math.floor(nowMs / 1000);
  const body = b64(JSON.stringify({ ...claims, jti: randomBytes(8).toString('hex'), iat, exp: iat + ttlSec }));
  return `v1.${body}.${b64(sign(secret, body))}`;
}

/** The token's claims, or null for anything but a well-signed, unexpired token. */
export function verifyVoiceToken(secret: string, token: unknown, nowMs = Date.now()): VoiceClaims | null {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const want = sign(secret, parts[1]);
  let got: Buffer;
  try {
    got = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: VoiceClaims;
  try {
    c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as VoiceClaims;
  } catch {
    return null;
  }
  const now = Math.floor(nowMs / 1000);
  if (typeof c.uid !== 'string' || !c.uid || typeof c.sid !== 'string' || !c.sid || typeof c.jti !== 'string') return null;
  if (typeof c.exp !== 'number' || typeof c.iat !== 'number' || c.exp <= now || c.exp - c.iat > VOICE_TOKEN_TTL_SEC || c.iat > now + 30) return null;
  return c;
}

/** Constant-time check of the bearer the voice service presents on the internal routes. */
export function bearerMatches(secret: string | null, header: string | null): boolean {
  if (!secret || !header) return false;
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!given) return false;
  const a = createHmac('sha256', 'bearer').update(given).digest();
  const b = createHmac('sha256', 'bearer').update(secret).digest();
  return timingSafeEqual(a, b);
}
