// Daily's REST API, as the voice room uses it (design Decision 4): one private, audio-only room
// per voice session that two participants may join (the candidate and the bot), expiring with the
// session, never recorded; a meeting token per participant. Nothing else of Daily's is used.
// `fetch` is injectable for tests; the voice service dials the room out with its own token.

export type DailyRoom = { name: string; url: string; expiresAt: string };

export class DailyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Opts = { apiUrl: string; apiKey: string; fetch?: typeof fetch; /** The region whose media server carries the room (Daily's `geo`), or Daily's choice. */ geo?: string | null };

const call = async <T>(opts: Opts, method: string, path: string, body?: unknown): Promise<T> => {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.apiUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    // Daily says what was wrong in `info`; it goes in the log, never to the room.
    const info = await res.text().then((t) => (JSON.parse(t) as { info?: string }).info ?? '').catch(() => '');
    throw new DailyError(`Daily ${method} ${path}: ${res.status}${info ? ` (${info})` : ''}`, res.status);
  }
  return (await res.json().catch(() => ({}))) as T;
};

/**
 * A private room for one session: two participants, audio only, no recording or chat, ejected
 * when it expires (the session's planned length plus overtime plus a margin for the park limit).
 * Its media server sits in `opts.geo` (ap-south-1 beside the voice service and the candidates;
 * a US one would add about 0.1 s to each direction of audio).
 */
export async function createRoom(opts: Opts, name: string, expiresAt: Date): Promise<DailyRoom> {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const out = await call<{ name: string; url: string }>(opts, 'POST', '/rooms', {
    name,
    privacy: 'private',
    properties: {
      exp,
      eject_at_room_exp: true,
      max_participants: 2,
      ...(opts.geo ? { geo: opts.geo } : {}),
      // Recording is off unless enable_recording names a kind ('cloud', 'local', 'raw-tracks'); the
      // API refuses the value 'off'.
      enable_chat: false,
      enable_screenshare: false,
      start_video_off: true,
      start_audio_off: false,
      enable_knocking: false,
      enable_prejoin_ui: false,
      enable_people_ui: false,
      enable_network_ui: false,
      enable_emoji_reactions: false,
    },
  });
  return { name: out.name, url: out.url, expiresAt: expiresAt.toISOString() };
}

export async function deleteRoom(opts: Opts, name: string): Promise<void> {
  try {
    await call(opts, 'DELETE', `/rooms/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err instanceof DailyError && err.status === 404) return;
    throw err;
  }
}

/**
 * A meeting token for one participant of the room: the candidate (user_id = the session id, which
 * the pipeline admits) or the bot (owner, user_id 'bot'). Short-lived: minutes for the candidate's
 * join, the room's life for the bot. The candidate's `exp` bounds when they may join, not how long they
 * stay: ejecting at it dropped every lesson five minutes in. The room's own expiry ends the call.
 */
export async function createToken(opts: Opts, room: string, who: { userId: string; userName: string; owner: boolean }, expiresAt: Date): Promise<string> {
  const out = await call<{ token: string }>(opts, 'POST', '/meeting-tokens', {
    properties: {
      room_name: room,
      user_id: who.userId,
      user_name: who.userName,
      is_owner: who.owner,
      exp: Math.floor(expiresAt.getTime() / 1000),
      start_video_off: true,
      eject_at_token_exp: who.owner,
    },
  });
  return out.token;
}
