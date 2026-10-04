export type Clock = { now(): number };

type ByteLruOptions<V> = {
  maxBytes: number;
  ttlMs: number;
  sizeOf: (value: V) => number;
  clock: Clock;
};

type Entry<V> = { value: V; size: number; expiresAt: number };

export class ByteLru<V> {
  readonly #options: ByteLruOptions<V>;
  readonly #entries = new Map<string, Entry<V>>();
  #bytes = 0;

  constructor(options: ByteLruOptions<V>) {
    this.#options = options;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#options.clock.now() >= entry.expiresAt) {
      this.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    // Drop the old entry first so an oversized replacement cannot leave a stale value behind.
    this.delete(key);
    const size = this.#options.sizeOf(value);
    if (size > this.#options.maxBytes) return;
    for (const oldestKey of this.#entries.keys()) {
      if (this.#bytes + size <= this.#options.maxBytes) break;
      this.delete(oldestKey);
    }
    this.#entries.set(key, {
      value,
      size,
      expiresAt: this.#options.clock.now() + this.#options.ttlMs,
    });
    this.#bytes += size;
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.size;
  }
}
