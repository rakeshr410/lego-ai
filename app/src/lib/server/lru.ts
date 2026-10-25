/** A small bounded LRU with a per-entry TTL, for per-process caches. */
export class LRU<V> {
  #map = new Map<string, { value: V; expires: number }>();
  #max: number;
  #ttlMs: number;

  constructor(max: number, ttlMs: number) {
    this.#max = max;
    this.#ttlMs = ttlMs;
  }

  get(key: string): V | undefined {
    const e = this.#map.get(key);
    if (!e) return undefined;
    this.#map.delete(key);
    if (e.expires <= Date.now()) return undefined;
    this.#map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs = this.#ttlMs) {
    this.#map.delete(key);
    this.#map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value!);
  }

  delete(key: string) {
    this.#map.delete(key);
  }
}
