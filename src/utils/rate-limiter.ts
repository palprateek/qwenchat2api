import { createLogger } from './logger';

const logger = createLogger('rate-limiter');

interface RateBucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets: Map<string, RateBucket> = new Map();
  private maxRequests: number;
  private windowMs: number = 60_000; // 1 minute

  constructor(maxRequests: number = 30) {
    this.maxRequests = maxRequests;
  }

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count++;
    const remaining = Math.max(0, this.maxRequests - bucket.count);
    const allowed = bucket.count <= this.maxRequests;

    if (!allowed) {
      logger.warn(`Rate limit exceeded for ${key}: ${bucket.count}/${this.maxRequests}`);
    }

    return { allowed, remaining, resetAt: bucket.resetAt };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}
