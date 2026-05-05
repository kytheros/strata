// ElastiCache Redis Serverless cache wrapper for the AWS-SDK tool catalog.
//
// AWS-3.3 caches every read-only SDK call: per-tool TTL (30s for logs, up
// to 1h for identity/cost data). The cache lives in the Phase 1
// `elasticache-redis` module — Serverless, TLS-only, AUTH-token via
// Secrets Manager. The task-role IAM policy grants
// `secretsmanager:GetSecretValue` on the auth-token secret + `kms:Decrypt`
// on the per-cache CMK.
//
// Why Redis over a process-local LRU: Fargate runs N tasks behind the
// ingress; a process-local cache splits hits N ways and warms slowly.
// ElastiCache Serverless ($1/mo idle) keeps the warm cache shared and
// survives task restarts — a real win once we're paying for Anthropic
// tokens by the request.
//
// Key shape: `awstool:${toolName}:${shortHash(input)}` (12-char SHA-256
// truncation). Per the design spec — short keys keep memory pressure
// low; the prefix scopes the namespace cleanly inside a shared cache.
//
// Native `redis` (the official Redis client) is allowed under the repo's
// supply-chain policy: it's a Redis-protocol (RESP) client, not an HTTP
// client — the ban list (axios/got/node-fetch/superagent/request) covers
// HTTP only.

import { createHash } from 'crypto';
import { createClient, type RedisClientType } from 'redis';

// Module-level singleton. Lazily initialized so unit tests that don't
// touch the cache never connect, and so a Lambda/Fargate worker reuses
// one TLS connection across requests.
let clientPromise: Promise<RedisClientType> | null = null;

function getRedisUrl(): string | null {
  const endpoint = process.env.REDIS_ENDPOINT;
  const port = process.env.REDIS_PORT ?? '6379';
  const auth = process.env.REDIS_AUTH_TOKEN;
  if (!endpoint || !auth) return null;
  // rediss:// = TLS. ElastiCache Serverless is TLS-only. AUTH token is
  // URL-safe per ElastiCache user-management requirements.
  return `rediss://default:${encodeURIComponent(auth)}@${endpoint}:${port}`;
}

async function getClient(): Promise<RedisClientType | null> {
  const url = getRedisUrl();
  if (!url) return null;
  if (!clientPromise) {
    const client = createClient({ url, socket: { tls: true } });
    // Don't crash the Node process on a transient cache error — log and
    // let the next request reconnect. Cache misses are not user-visible
    // failures; they just mean we hit the AWS API one more time.
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[cache] redis error:', err);
    });
    clientPromise = client.connect().then(() => client as RedisClientType);
  }
  return clientPromise;
}

export interface CacheOptions {
  ttlSec: number;
}

export class ToolCache {
  // Get a cached value by short key. Misses (no entry, or no Redis at all)
  // return null — callers fall through to the SDK call.
  async get<T>(key: string): Promise<T | null> {
    const client = await getClient();
    if (!client) return null;
    try {
      const val = await client.get(`awstool:${key}`);
      return val ? (JSON.parse(val) as T) : null;
    } catch (err) {
      // Cache failures should never fail the request. Log + miss.
      // eslint-disable-next-line no-console
      console.error('[cache] get failed:', err);
      return null;
    }
  }

  async set<T>(key: string, value: T, opts: CacheOptions): Promise<void> {
    const client = await getClient();
    if (!client) return;
    try {
      await client.set(`awstool:${key}`, JSON.stringify(value), {
        EX: opts.ttlSec,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cache] set failed:', err);
    }
  }
}

// SHA-256 first 12 hex chars. Plenty of collision resistance at our
// per-tool key cardinality; keeps the key short for Redis memory.
export function shortHash(input: unknown): string {
  const json = JSON.stringify(input ?? {});
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

// In-memory cache for unit tests — the test harness substitutes this for
// the Redis-backed implementation so we exercise the cache-hit path
// without spinning up a Redis container.
export class InMemoryToolCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(`awstool:${key}`);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(`awstool:${key}`);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, opts: CacheOptions): Promise<void> {
    this.store.set(`awstool:${key}`, {
      value,
      expiresAt: Date.now() + opts.ttlSec * 1000,
    });
  }

  // Test helper.
  clear(): void {
    this.store.clear();
  }
}
