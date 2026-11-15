export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type RateLimiter = {
  check: (key: string) => RateLimitResult;
  reset: () => void;
};

export function createRateLimiter({
  maxRequests,
  windowMs,
  now = () => Date.now(),
}: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const hits = new Map<string, number[]>();

  function pruneStale(cutoff: number) {
    if (hits.size < 1000) return;
    for (const [k, timestamps] of hits) {
      const recent = timestamps.filter((t) => t > cutoff);
      if (recent.length === 0) {
        hits.delete(k);
      } else {
        hits.set(k, recent);
      }
    }
  }

  return {
    check(key: string): RateLimitResult {
      const current = now();
      const cutoff = current - windowMs;
      pruneStale(cutoff);

      const previous = hits.get(key) ?? [];
      const recent = previous.filter((t) => t > cutoff);

      if (recent.length >= maxRequests) {
        const oldest = recent[0];
        const retryAfterMs = Math.max(1000, oldest + windowMs - current);
        hits.set(key, recent);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        };
      }

      recent.push(current);
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - recent.length),
        retryAfterSeconds: 0,
      };
    },
    reset() {
      hits.clear();
    },
  };
}
