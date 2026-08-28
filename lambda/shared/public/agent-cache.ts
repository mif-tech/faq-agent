/**
 * edition 間で共有する agentId スコープのコンテナ内キャッシュ。
 *
 * Lambda のウォームコンテナではモジュールスコープの状態が invocation 間で再利用されるため、
 * 値を単一変数に保持すると別エージェントへ漏れる。必ず agentId をキーにし、TTL と LRU の
 * サイズ上限で、古い設定・索引と無制限なメモリ増加の両方を抑える。
 */

export interface AgentScopedCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** 単体テストで時刻を固定するための差し替え口 */
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface CacheLookup<T> {
  hit: boolean;
  value?: T;
}

interface InFlightLoad<T> {
  promise: Promise<T>;
  token: object;
}

export class AgentScopedCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, InFlightLoad<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: AgentScopedCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('AgentScopedCache ttlMs must be a positive number');
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error('AgentScopedCache maxEntries must be a positive integer');
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  /**
   * agentId の値を返し、未キャッシュ・期限切れの場合だけ loader を呼ぶ。
   * 同じ agentId の同時ロードは1本へまとめるが、別 agentId のロードとは共有しない。
   */
  async getOrLoad(
    agentId: string,
    loader: (agentId: string) => Promise<T>
  ): Promise<T> {
    this.assertAgentId(agentId);

    const cached = this.lookup(agentId);
    if (cached.hit) return cached.value as T;

    const existingLoad = this.inFlight.get(agentId);
    if (existingLoad) return existingLoad.promise;

    const token = {};
    const loading = (async () => {
      const value = await loader(agentId);
      // load 中に PUT/DELETE が走った場合、古い読み取り結果で新しい値を上書きしない。
      if (this.inFlight.get(agentId)?.token === token) {
        this.store(agentId, value);
      }
      return value;
    })();
    this.inFlight.set(agentId, { promise: loading, token });

    try {
      return await loading;
    } finally {
      if (this.inFlight.get(agentId)?.token === token) {
        this.inFlight.delete(agentId);
      }
    }
  }

  /** 書込直後の値を反映し、進行中の古いロード結果を無効化する。 */
  set(agentId: string, value: T): void {
    this.assertAgentId(agentId);
    this.inFlight.delete(agentId);
    this.store(agentId, value);
  }

  /** 該当 agentId だけを無効化する。 */
  invalidate(agentId: string): void {
    this.assertAgentId(agentId);
    this.inFlight.delete(agentId);
    this.entries.delete(agentId);
  }

  /** テストまたは明示的な全再読込用。 */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private lookup(agentId: string): CacheLookup<T> {
    const entry = this.entries.get(agentId);
    if (!entry) return { hit: false };
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(agentId);
      return { hit: false };
    }

    // Map の挿入順を LRU として使うため、hit した要素を末尾へ移す。
    this.entries.delete(agentId);
    this.entries.set(agentId, entry);
    return { hit: true, value: entry.value };
  }

  private store(agentId: string, value: T): void {
    this.removeExpiredEntries();
    this.entries.delete(agentId);
    this.entries.set(agentId, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestAgentId = this.entries.keys().next().value;
      if (oldestAgentId === undefined) break;
      this.entries.delete(oldestAgentId);
    }
  }

  private removeExpiredEntries(): void {
    const now = this.now();
    for (const [agentId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(agentId);
    }
  }

  private assertAgentId(agentId: string): void {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new Error('AgentScopedCache agentId must be a non-empty string');
    }
  }
}
