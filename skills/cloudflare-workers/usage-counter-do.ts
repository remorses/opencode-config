// Usage counter Durable Object with SQLite storage (append-only event log).
//
// Tracks usage as individual event rows, each with a key, count/tokens,
// and created_at timestamp. Totals are derived by summing rows, and you
// can query usage within any time window (last month, last week, etc.).
//
// Use one DO instance per entity (e.g. per project via idFromName(projectId)).
// Each instance has its own isolated SQLite database.
//
// Pricing context (as of 2026):
//   - DO requests: $0.15/million (1M free/month)
//   - DO duration: $12.50/million GB-s (400K free/month)
//   - For fire-and-forget writes (~5ms each), duration cost is negligible
//   - KV writes cost $5/million and are NOT atomic — avoid for counters
//   - Analytics Engine is sampled — use for dashboards, not exact billing
//
// wrangler.jsonc bindings:
//
//   "durable_objects": {
//     "bindings": [{ "name": "USAGE_COUNTER", "class_name": "UsageCounter" }]
//   },
//   "migrations": [
//     { "tag": "v1", "new_sqlite_classes": ["UsageCounter"] }
//   ]
//
// Calling from a Worker:
//
//   import { env } from 'cloudflare:workers'
//   import type { UsageCounter } from './usage-counter-do.ts'
//
//   function getUsageStub(projectId: string) {
//     const id = env.USAGE_COUNTER.idFromName(projectId)
//     return env.USAGE_COUNTER.get(id) as DurableObjectStub<UsageCounter>
//   }
//
//   // Record a usage event
//   await getUsageStub('proj_123').record('api-calls')
//   await getUsageStub('proj_123').record('tokens', 1500)
//
//   // Get total usage for a key (all time)
//   const total = await getUsageStub('proj_123').getTotal('tokens')
//
//   // Get usage in a time window (e.g. current billing month)
//   const monthStart = new Date('2026-07-01').getTime()
//   const usage = await getUsageStub('proj_123').getTotalSince('api-calls', monthStart)
//
//   // Get breakdown by key for a time window
//   const breakdown = await getUsageStub('proj_123').getBreakdownSince(monthStart)

import { DurableObject } from 'cloudflare:workers'

export interface UsageEvent {
  key: string
  count: number
  createdAt: number
}

export class UsageCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_key_created
      ON usage_events (key, created_at)
    `)
  }

  /** Record a usage event. Count defaults to 1 (e.g. one API call). */
  async record(key: string, count = 1): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO usage_events (key, count, created_at) VALUES (?, ?, ?)`,
      key,
      count,
      Date.now(),
    )
  }

  /** Total count for a key across all time. */
  async getTotal(key: string): Promise<number> {
    const row = this.ctx.storage.sql
      .exec(`SELECT COALESCE(SUM(count), 0) AS total FROM usage_events WHERE key = ?`, key)
      .one()
    return row.total as number
  }

  /** Total count for a key since a given timestamp (epoch ms). */
  async getTotalSince(key: string, sinceMs: number): Promise<number> {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT COALESCE(SUM(count), 0) AS total FROM usage_events WHERE key = ? AND created_at >= ?`,
        key,
        sinceMs,
      )
      .one()
    return row.total as number
  }

  /** Breakdown of all keys with their totals, optionally since a timestamp. */
  async getBreakdownSince(sinceMs = 0): Promise<Record<string, number>> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT key, COALESCE(SUM(count), 0) AS total FROM usage_events WHERE created_at >= ? GROUP BY key`,
        sinceMs,
      )
      .toArray()
    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.key as string] = row.total as number
    }
    return result
  }

  /** List raw events for a key in a time range (useful for detailed audit). */
  async listEvents(key: string, sinceMs = 0, limit = 1000): Promise<UsageEvent[]> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT key, count, created_at FROM usage_events WHERE key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
        key,
        sinceMs,
        limit,
      )
      .toArray()
    return rows.map((row) => ({
      key: row.key as string,
      count: row.count as number,
      createdAt: row.created_at as number,
    }))
  }

  /** Prune events older than a given timestamp. Run periodically to keep storage small. */
  async pruneOlderThan(beforeMs: number): Promise<number> {
    this.ctx.storage.sql.exec(
      `DELETE FROM usage_events WHERE created_at < ?`,
      beforeMs,
    )
    const row = this.ctx.storage.sql.exec(`SELECT changes() AS deleted`).one()
    return row.deleted as number
  }
}
