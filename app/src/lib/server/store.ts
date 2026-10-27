import type { Redis } from 'ioredis';
import { assertProductionConfig, env } from './env';
import { onShutdown } from './lifecycle';

// Shared key-value state for sessions, rate limits and locks. Redis when REDIS_URL is set
// (required in production, so every web instance sees the same state); otherwise a bounded
// in-memory map, which is fine for a single dev server.

export interface Store {
  get(key: string): Promise<string | null>;
  /** Sets a value that expires after ttlMs. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Sets only if the key doesn't exist; returns whether it was set. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Replaces the value only if it is still `expected`; returns whether it was replaced. */
  cas(key: string, expected: string, value: string, ttlMs: number): Promise<boolean>;
  /** Increments a counter, starting its ttlMs window on the first hit. */
  incr(key: string, ttlMs: number): Promise<number>;
  /** Adds a (fractional) amount to a number, starting its ttlMs window on the first add; returns the new total. */
  incrByFloat(key: string, delta: number, ttlMs: number): Promise<number>;
  /** Deletes the key only while it still holds `expected` (releasing a lock we own); returns whether it did. */
  delIfEquals(key: string, expected: string): Promise<boolean>;
  /**
   * Increments a counter that never goes below `floor`: a missing (or lower) value starts at
   * `floor`. A fencing token that stays monotonic even if the store loses the key (billing).
   */
  incrAtLeast(key: string, floor: number, ttlMs: number): Promise<number>;
  /** The live keys that start with `prefix` (a report's scan of the store; never on a request's path). */
  keys?(prefix: string): Promise<string[]>;
}

const PREFIX = 'bp:';

class MemoryStore implements Store {
  #map = new Map<string, { value: string; expires: number }>();
  #max: number;
  constructor(max = 50_000) {
    this.#max = max;
  }

  async keys(prefix: string) {
    return [...this.#map.keys()].filter((k) => k.startsWith(prefix) && this.#live(k));
  }

  #live(key: string) {
    const e = this.#map.get(key);
    if (!e) return null;
    if (e.expires <= Date.now()) {
      this.#map.delete(key);
      return null;
    }
    return e;
  }

  #put(key: string, value: string, ttlMs: number) {
    this.#map.delete(key);
    this.#map.set(key, { value, expires: Date.now() + ttlMs });
    if (this.#map.size > this.#max) {
      const now = Date.now();
      for (const [k, e] of this.#map) if (e.expires <= now) this.#map.delete(k);
      // Still full: drop the oldest writes (Map keeps insertion order).
      for (const k of this.#map.keys()) {
        if (this.#map.size <= this.#max) break;
        this.#map.delete(k);
      }
    }
  }

  async get(key: string) {
    return this.#live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlMs: number) {
    this.#put(key, value, ttlMs);
  }
  async setNx(key: string, value: string, ttlMs: number) {
    if (this.#live(key)) return false;
    this.#put(key, value, ttlMs);
    return true;
  }
  async del(key: string) {
    this.#map.delete(key);
  }
  async cas(key: string, expected: string, value: string, ttlMs: number) {
    if (this.#live(key)?.value !== expected) return false;
    this.#put(key, value, ttlMs);
    return true;
  }
  async incr(key: string, ttlMs: number) {
    const e = this.#live(key);
    if (!e) {
      this.#put(key, '1', ttlMs);
      return 1;
    }
    const n = Number(e.value) + 1;
    e.value = String(n);
    return n;
  }
  async incrByFloat(key: string, delta: number, ttlMs: number) {
    const e = this.#live(key);
    if (!e) {
      this.#put(key, String(delta), ttlMs);
      return delta;
    }
    const n = Number(e.value) + delta;
    // Like Redis: a value that isn't a number is an error, not a reset.
    if (!Number.isFinite(n)) throw new Error('value is not a valid float');
    e.value = String(n);
    return n;
  }
  async delIfEquals(key: string, expected: string) {
    if (this.#live(key)?.value !== expected) return false;
    this.#map.delete(key);
    return true;
  }
  async incrAtLeast(key: string, floor: number, ttlMs: number) {
    const n = Math.max(Number(this.#live(key)?.value ?? 0) + 1, floor);
    this.#put(key, String(n), ttlMs);
    return n;
  }
}

// INCR and start the expiry on the first hit, atomically.
const INCR_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

// INCRBYFLOAT and give the key an expiry if it has none (the first add), atomically.
const INCR_FLOAT_SCRIPT = `local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v`;

// SET only while the key still holds the expected value, atomically.
const CAS_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;

// DEL only while the key still holds the expected value, atomically.
const DEL_IF_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;

// INCR, lifted to at least the floor, with the expiry renewed, atomically.
const INCR_FLOOR_SCRIPT = `local n = redis.call('INCR', KEYS[1])
local floor = tonumber(ARGV[1])
if n < floor then n = floor redis.call('SET', KEYS[1], ARGV[1]) end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return n`;

class RedisStore implements Store {
  redis: Redis;
  constructor(redis: Redis) {
    this.redis = redis;
  }
  async get(key: string) {
    return this.redis.get(PREFIX + key);
  }
  async keys(prefix: string) {
    const out: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = this.redis.scanStream({ match: `${PREFIX}${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`, count: 200 });
      stream.on('data', (batch: string[]) => out.push(...batch.map((k) => k.slice(PREFIX.length))));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return out;
  }
  async set(key: string, value: string, ttlMs: number) {
    await this.redis.set(PREFIX + key, value, 'PX', Math.max(1, Math.round(ttlMs)));
  }
  async setNx(key: string, value: string, ttlMs: number) {
    return (await this.redis.set(PREFIX + key, value, 'PX', Math.max(1, Math.round(ttlMs)), 'NX')) === 'OK';
  }
  async del(key: string) {
    await this.redis.del(PREFIX + key);
  }
  async cas(key: string, expected: string, value: string, ttlMs: number) {
    const ttl = Math.max(1, Math.round(ttlMs));
    return Number(await this.redis.eval(CAS_SCRIPT, 1, PREFIX + key, expected, value, ttl)) === 1;
  }
  async incr(key: string, ttlMs: number) {
    return Number(await this.redis.eval(INCR_SCRIPT, 1, PREFIX + key, Math.max(1, Math.round(ttlMs))));
  }
  async incrByFloat(key: string, delta: number, ttlMs: number) {
    const ttl = Math.max(1, Math.round(ttlMs));
    return Number(await this.redis.eval(INCR_FLOAT_SCRIPT, 1, PREFIX + key, String(delta), ttl));
  }
  async delIfEquals(key: string, expected: string) {
    return Number(await this.redis.eval(DEL_IF_SCRIPT, 1, PREFIX + key, expected)) === 1;
  }
  async incrAtLeast(key: string, floor: number, ttlMs: number) {
    const ttl = Math.max(1, Math.round(ttlMs));
    return Number(await this.redis.eval(INCR_FLOOR_SCRIPT, 1, PREFIX + key, String(Math.floor(floor)), ttl));
  }
}

let store: Promise<Store> | null = null;

async function connect(): Promise<Store> {
  assertProductionConfig();
  const url = env('REDIS_URL');
  if (!url) return new MemoryStore();
  // Loaded only when configured, so dev works without the package being installed.
  const { Redis } = await import('ioredis');
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    enableOfflineQueue: true,
  });
  redis.on('error', (err) => console.error('[store] redis error:', err.message));
  // Let pending commands finish when the process shuts down (scripts/drain.ts).
  onShutdown(() => redis.quit());
  return new RedisStore(redis);
}

/** The shared store. Throws in production when REDIS_URL is missing. */
export function getStore(): Promise<Store> {
  store ??= connect().catch((err) => {
    store = null;
    throw err;
  });
  return store;
}
