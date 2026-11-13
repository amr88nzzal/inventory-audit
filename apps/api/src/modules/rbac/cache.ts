// ذاكرة مؤقتة قصيرة لصلاحيات المستخدم: تُبطَل فور تغيير الأدوار على هذه النسخة، وتنتهي وحدها
// بعد المدة على أي نسخة أخرى (حدّ أقصى لتأخر سريان التغيير).
// A short cache of a user's permissions: invalidated immediately on a role change on this instance,
// and expiring by itself after the TTL on any other instance (the upper bound on how stale a change can be).

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCache<V> {
  get: (key: string, now?: number) => V | undefined;
  set: (key: string, value: V, now?: number) => void;
  /** يحذف كل المفاتيح التي تبدأ بالبادئة (شركة كاملة). Drops every key with the prefix (a whole company). */
  invalidatePrefix: (prefix: string) => void;
  size: () => number;
}

export const createTtlCache = <V>(ttlMs: number, maxEntries = 10_000): TtlCache<V> => {
  const map = new Map<string, Entry<V>>();
  return {
    get: (key, now = Date.now()) => {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set: (key, value, now = Date.now()) => {
      // سقف للحجم كي لا ينمو بلا حد: نحذف الأقدم إدراجاً.
      // A size cap so it cannot grow without bound: evict the oldest inserted.
      if (map.size >= maxEntries && !map.has(key)) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { value, expiresAt: now + ttlMs });
    },
    invalidatePrefix: (prefix) => {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    },
    size: () => map.size,
  };
};
