import Fastify from 'fastify';
import FastifyFormbody from '@fastify/formbody';
import type { JSONSchema } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { base62Encode, base62Decode } from '../urlshortener-core/src';
import Redis from 'ioredis';
import pg from 'pg';
import NATS from 'nats';
import Pledge from 'opossum';

// Types
interface ShortenRequest {
  url: string;
  custom_alias?: string;
  expires_in?: number; // seconds
}

interface ShortenResponse {
  short_code: string;
  url: string;
  expires_at?: number;
}

interface ResolveResponse {
  url: string;
  expires_at?: number;
  click_count?: number;
}

// Redis connection
const redis = new Redis({ host: 'localhost', port: 6379, lazyConnect: true });

// PostgreSQL pool
const { Pool } = pg;
const pgPool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'urlshortener',
});

// NATS connection
let natsClient: NATS.Client;
async function initNATS() {
  natsClient = NATS.connect({ servers: ['nats://localhost:4222'] });
  await natsClient.flushReady(); // wait for connection
}

// In-memory LRU cache for recent resolutions (max 1000 entries)
import LRU from 'lru-cache';
const lruCache = new LRU<string, { url: string; expires_at: number; click_count: number }>({
  max: 1000,
  ttl: 60 * 1000, // 1 minute
});

// Map of Promises for request coalescing
const resolvingPromises = new Map<string, Promise<{ url: string; expires_at?: number; click_count?: number }>>();

async function resolveFromCache(code: string): Promise<{ url: string; expires_at?: number; click_count?: number } | null> {
  // 1. Check LRU cache first
  const lruResult = lruCache.get(code);
  if (lruResult) {
    return { url: lruResult.url, expires_at: lruResult.expires_at, click_count: lruResult.click_count };
  }

  // 2. Check if a resolution is already in progress (coalescing)
  if (resolvingPromises.has(code)) {
    return resolvingPromises.get(code)!;
  }

  // 3. Negative caching: check Redis for "not found" marker
  const negKey = `neg:${code}`;
  const negExists = await redis.exists(negKey);
  if (negExists) {
    // Code does not exist; return null quickly
    return null;
  }

  // 4. Start resolution promise (coalesce concurrent requests)
  const promise = new Promise<{ url: string; expires_at?: number; click_count?: number } | null>(async (resolve) => {
    try {
      // Fetch from PostgreSQL
      const client = await pgPool.connect();
      try {
        const res = await client.query('SELECT url, expires_at, click_count FROM urls WHERE short_code = $1', [code]);
        if (res.rowCount === 0) {
          // Code not found - add to negative cache with short TTL
          await redis.set(negKey, '1', 'EX', 300); // 5 minutes negative cache
          resolve(null);
        } else {
          const row = res.rows[0];
          const urlData = {
            url: row.url,
            expires_at: row.expires_at,
            click_count: row.click_count,
          };
          // Cache in LRU and Redis
          lruCache.set(code, urlData);
          await redis.set(code, JSON.stringify(urlData), 'EX', 24 * 3600); // 24h
          resolve(urlData);
        }
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Resolve error:', err);
      resolve(null);
    } finally {
      // Remove from coalescing map
      resolvingPromises.delete(code);
    }
  });

  // Store the promise in the map
  resolvingPromises.set(code, promise);

  // Wait for the promise to complete
  const result = await promise;
  return result;
}

// Rate limiting using token bucket in Redis with Lua script
const rateLimitLuaScript = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local take = tonumber(ARGV[4])

local bucket = redis.call('GET', key)
if bucket then
  local data = cjson.decode(bucket)
  local filled = now - data.refill_time
  local filled_amount = math.floor(filled * refill_rate / 1000)
  local tokens = math.min(capacity, data.tokens + filled_amount)
  if tokens >= take then
    tokens = tokens - 1
    redis.call('SET', key, cjson.encode({tokens=tokens, refill_time=now}))
    return 1
  else
    return 0
  end
else
  redis.call('SET', key, cjson.encode({tokens=capacity-1, refill_time=now}))
  return 1
end
`;

let rateLimitScriptSha: string | null = null;

async function initRateLimitScript(redisClient: any) {
  rateLimitScriptSha = await redisClient.script('LOAD', rateLimitLuaScript);
}

// Rate limit check
async function checkRateLimit(clientIp: string): Promise<boolean> {
  const key = `rl:${clientIp}`;
  const capacity = 100; // max requests per window
  const refill_rate = 1000; // tokens per 1000ms (adjust as needed)
  const windowMs = 60 * 1000; // 1 minute window
  const now = Date.now();

  if (!rateLimitScriptSha) {
    // Fallback: simple decrement
    const current = await redis.get(key);
    if (current === null) {
      await redis.set(key, 99);
      return true;
    }
    const val = parseInt(current, 10);
    if (val > 0) {
      await redis.decr(key);
      return true;
    }
    return false;
  }

  // Use Lua script
  const result = await redis.evalsha(rateLimitScriptSha, 1, key, capacity.toString(), refill_rate.toString(), now.toString(), '1');
  return result === 1;
}

// Circuit breaker for PostgreSQL using opossum
const CircuitBreaker = require('opossum');

const pgBreakerOptions = {
  timeout: 5000, // open circuit after 5s of failures
  errorThresholdPercentage: 50, // open after 50% errors
  resetTimeout: 10000, // try close after 10s
};

const pgBreaker = new CircuitBreaker(
  async (code: string) => {
    const client = await pgPool.connect();
    try {
      const res = await client.query('SELECT url, expires_at, click_count FROM urls WHERE short_code = $1', [code]);
      client.release();
      if (res.rowCount === 0) return null;
      return res.rows[0];
    } catch (err) {
      client.release();
      throw err;
    }
  },
  pgBreakerOptions
);

pgBreaker.on('open', () => console.log('PG circuit breaker opened'));
pgBreaker.on('halfOpen', () => console.log('PG circuit breaker half-open'));
pgBreaker.on('close', () => console.log('PG circuit breaker closed'));
pgBreaker.on('failure', (err: any) => console.log('PG circuit breaker failure:', err.message));

async function initpgBreaker() {
  // Connect to force initial state
  await pgPool.connect();
}

// Shorten handler
async function handleShorten(request: { url: string; custom_alias?: string; expires_in?: number }, reply: any) {
  const { url, custom_alias, expires_in } = request;
  const now = Date.now();

  let shortCode: string;

  // If custom alias provided, validate and check availability
  if (custom_alias) {
    // Validate custom alias: alphanumeric, max 32 chars
    if (!/^[a-zA-Z0-9]+$/.test(custom_alias) || custom_alias.length > 32) {
      return reply.code(400).send({ error: 'Invalid custom alias format' });
    }
    // Check availability in Redis negative cache
    const negKey = `neg:${custom_alias}`;
    const negExists = await redis.exists(negKey);
    if (negExists) {
      return reply.code(409).send({ error: 'Custom alias already used or expired' });
    }
    // Check in-memory coalescing map
    if (resolvingPromises.has(custom_alias)) {
      return reply.code(409).send({ error: 'Custom alias currently being generated' });
    }
    // Check Redis directly
    const exists = await redis.exists(custom_alias);
    if (exists) {
      // Alias already taken; return existing URL
      const cached = await redis.get(custom_alias);
      if (cached) {
        const data = JSON.parse(cached);
        return reply.send({ short_code: custom_alias, url: data.url, expires_at: data.expires_at });
      }
    }
    shortCode = custom_alias;
  } else {
    // Generate unique code using distributed range allocation via Redis INCR
    shortCode = await generateUniqueCode(redis);
  }

  // Idempotency: check if code already exists (via Redis first)
  const cached = await redis.get(shortCode);
  if (cached) {
    const data = JSON.parse(cached);
    return reply.send({ short_code: shortCode, url: data.url, expires_at: data.expires_at });
  }

  // Check PostgreSQL for idempotency (in case of race condition across instances)
  const pgResult = await pgBreaker.fire(shortCode);
  if (pgResult && pgResult.url) {
    // Already exists, re-cache and return
    await redis.set(shortCode, JSON.stringify(pgResult), 'EX', 24 * 3600);
    return reply.send({ short_code: shortCode, url: pgResult.url, expires_at: pgResult.expires_at });
  }

  // Save to PostgreSQL
  const expiresAt = expires_in ? now + expires_in * 1000 : null;
  const clickCount = 0;
  try {
    await pgPool.query(
      'INSERT INTO urls (short_code, url, created_at, expires_at, click_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (short_code) DO NOTHING',
      [shortCode, url, now, expiresAt, clickCount]
    );
  } catch (err) {
    console.error('DB insert error:', err);
    return reply.code(500).send({ error: 'Failed to save URL' });
  }

  // Cache the new mapping in Redis
  const urlData = { url, expires_at: expiresAt, click_count: clickCount };
  await redis.set(shortCode, JSON.stringify(urlData), 'EX', expires_in ? Math.ceil(expires_in / 86400) : 24 * 3600); // expire in days or default 24h

  // Also update LRU cache
  lruCache.set(shortCode, urlData);

  reply.send({ short_code: shortCode, url, expires_at: expiresAt });
}

// Resolve handler
async function handleResolve(reply: any, code: string) {
  // Rate limiting per IP (simplified; real implementation would use request IP)
  const clientIp = '127.0.0.1'; // would get from request
  const rateOk = await checkRateLimit(clientIp);
  if (!rateOk) {
    return reply.code(429).send({ error: 'Too many requests' });
  }

  // Resolve with coalescing
  const urlData = await resolveFromCache(code);

  if (!urlData) {
    return reply.code(404).send({ error: 'URL not found' });
  }

  // Check expiry
  if (urlData.expires_at && Date.now() > urlData.expires_at) {
    // Remove expired entry
    await redis.del(code);
    lruCache.del(code);
    return reply.code(410).send({ error: 'URL has expired' });
  }

  // Increment click count atomically
  await pgPool.query('UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1', [code]);

  // Async click logging via NATS JetStream
  try {
    const payload = JSON.stringify({ code, ip: clientIp, timestamp: Date.now() });
    await natsClient.publish('clicks', payload);
    // Optionally also store in ClickHouse later (background process)
  } catch (err) {
    console.error('NATS publish error:', err);
    // Non-critical; continue redirect
  }

  // Redirect 302
  reply.redirect(302, urlData.url);
}

// Main server setup
async function main() {
  await redis.connect();
  await pgPool.connect();
  await initNATS();
  await initRateLimitScript(redis);
  await initpgBreaker();

  const fastify = Fastify({ logger: true });
  fastify.register(FastifyFormbody);

  // POST /api/shorten
  fastify.post('/api/shorten', async (request, reply) => {
    const body = request.body as ShortenRequest;
    await handleShorten(body, reply);
  });

  // GET /:kode
  fastify.get('/:kode', async (request, reply) => {
    const code = request.params.kode as string;
    await reply.setHeader('X-Rate-Limit-Remaining', '99'); // placeholder
    await handleResolve(reply, code);
  });

  // Start server
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log('URL shortener API listening on', port);

  // Graceful shutdown
  fastify.addHook('onClose', async (instance, done) => {
    await redis.quit();
    await pgPool.end();
    await natsClient.close();
    done();
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});