// Shared statement guard for AI/MCP query runners. Enforces a single statement
// and, in read-only mode, rejects anything that could mutate data — per engine.

const READ_ONLY_REDIS = new Set([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN',
  'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HMGET', 'HSCAN',
  'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'SSCAN',
  'ZRANGE', 'ZREVRANGE', 'ZCARD', 'ZSCORE', 'ZRANGEBYSCORE', 'ZSCAN',
  'XRANGE', 'XLEN', 'XINFO', 'INFO', 'DBSIZE', 'MEMORY', 'OBJECT', 'PING'
])

/**
 * Normalize and validate a single statement before running it. Strips a trailing
 * semicolon, forbids multiple statements, and — when `readOnly` — applies the
 * per-engine read-only allowlist. Returns the cleaned statement or throws.
 */
export function prepareStatement(driver: string, sql: string, readOnly: boolean): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) throw new Error('Empty query.')
  if (/;/.test(trimmed)) throw new Error('Only a single statement is allowed.')
  if (!readOnly) return trimmed

  if (driver === 'mongodb') {
    // The Mongo adapter only exposes read methods, so it's read-only already.
  } else if (driver === 'redis') {
    const cmd = trimmed.split(/\s+/)[0]?.toUpperCase() ?? ''
    if (!READ_ONLY_REDIS.has(cmd)) {
      throw new Error(`Only read-only Redis commands are allowed (got "${cmd}").`)
    }
  } else if (driver === 'influxdb') {
    if (/\bto\s*\(/i.test(trimmed)) throw new Error('Only read-only Flux is allowed.')
  } else if (!/^(select|with|explain|show|pragma)\b/i.test(trimmed)) {
    throw new Error('Only read-only queries (SELECT / WITH / EXPLAIN / SHOW) are allowed.')
  }
  return trimmed
}
