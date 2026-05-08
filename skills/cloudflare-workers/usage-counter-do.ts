// Usage counter Durable Object with SQLite storage.
//
// Tracks per-key usage counts using named RPC methods (not fetch).
// Each key is a row in a SQLite table. Increments are atomic SQL
// UPDATE statements via INSERT ... ON CONFLICT. The DO hibernates
// after 10s of inactivity, so you only pay for the few ms each
// increment takes.
//
// Use one DO instance per entity (e.g. per project via idFromName(projectId)).
// Each instance has its own isolated SQLite database.
//
// Pricing context (as of 2026):
//   - DO requests: $0.15/million (1M free/month)
//   - DO duration: $12.50/million GB-s (400K free/month)
//   - For fire-and-forget increments (~5ms each), duration cost is negligible
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
//   // Increment (fire-and-forget is fine — awaiting gives you the new count)
//   const count = await getUsageStub('proj_123').increment('api-calls')
//
//   // Read current counts
//   const counts = await getUsageStub('proj_123').getAllCounts()
//
//   // Reset at billing cycle boundary
//   await getUsageStub('proj_123').resetAll()

import { DurableObject } from 'cloudflare:workers'

export class UsageCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      )
    `)
  }

  /** Increment a key by a given amount (default 1). Returns the new count. */
  async increment(key: string, amount = 1): Promise<number> {
    this.ctx.storage.sql.exec(
      `INSERT INTO usage (key, count) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + ?`,
      key,
      amount,
      amount,
    )
    const row = this.ctx.storage.sql
      .exec(`SELECT count FROM usage WHERE key = ?`, key)
      .one()
    return row.count as number
  }

  /** Get the current count for a key. Returns 0 if not tracked yet. */
  async getCount(key: string): Promise<number> {
    const row = this.ctx.storage.sql
      .exec(`SELECT count FROM usage WHERE key = ?`, key)
      .one()
    return (row?.count as number) ?? 0
  }

  /** Get all counts as a key-value record. */
  async getAllCounts(): Promise<Record<string, number>> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT key, count FROM usage`)
      .toArray()
    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.key as string] = row.count as number
    }
    return result
  }

  /** Reset a single key back to zero (deletes the row). */
  async reset(key: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM usage WHERE key = ?`, key)
  }

  /** Reset all counters. Useful at billing cycle boundaries. */
  async resetAll(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM usage`)
  }
}
