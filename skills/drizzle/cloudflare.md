# Drizzle on Cloudflare

Companion doc for the main Drizzle skill. This file covers Cloudflare-specific runtime wiring, driver selection, and migration rules.

Read it when the project is **deployed on Cloudflare** or uses any of these:

- **D1**
- **Hyperdrive**
- **Durable Objects**
- **wrangler**
- **`cloudflare:workers`** imports

## Connection shape

For environments where the connection depends on runtime bindings, prefer a factory or conditional exports instead of `process.env` branches inside one file.

**Do NOT use `drizzle-orm/d1` at runtime.** The D1 driver's `mapGetResult()` is broken: when `db.batch()` runs a `findFirst()` that returns no results, the driver passes `undefined` to `customResultMapper` which crashes in `mapRelationalRow` with `TypeError: Cannot read properties of undefined (reading 'id')` (drizzle-team/drizzle-orm#2721). The `sqlite-proxy` driver has this guard and works correctly. Import the `D1Database` **type** from `drizzle-orm/d1` for typing, but use `drizzle-orm/sqlite-proxy` for the runtime driver.

```ts
// Cloudflare D1 — sqlite-proxy runtime, D1Database type only from drizzle-orm/d1
import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { D1Database } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

export { schema }

// Convert D1 object rows to positional arrays for sqlite-proxy.
// Same logic as drizzle-orm's internal d1ToRawMapping.
function d1ToRawRows(results: Record<string, unknown>[]) {
  return results.map((row) => Object.keys(row).map((k) => row[k]))
}

export function getDb(d1: D1Database = env.DB) {
  return drizzle(
    async (sql, params, method) => {
      const stmt = d1.prepare(sql).bind(...params)
      if (method === 'run') { await stmt.run(); return { rows: [] as any[] } }
      // raw() returns positional arrays which sqlite-proxy expects.
      // all() returns objects which break mapResultRow (indexes by position).
      const rows = await stmt.raw()
      // sqlite-proxy expects a falsy value for `get` no-row results.
      // Returning [] is truthy and produces { id: undefined } in findFirst.
      // https://github.com/drizzle-team/drizzle-orm/issues/5461
      if (method === 'get') return { rows: rows[0] as any }
      return { rows: rows as any[] }
    },
    async (queries) => {
      // D1 batch() is atomic but only returns object rows (no raw()),
      // so convert to positional arrays for sqlite-proxy.
      const stmts = queries.map((q) => d1.prepare(q.sql).bind(...q.params))
      const results = await d1.batch(stmts)
      return results.map((r, i) => {
        const rows = d1ToRawRows(r.results as Record<string, unknown>[])
        if (queries[i]!.method === 'get') return { rows: rows[0] as any }
        return { rows: rows as any[] }
      })
    },
    { schema, relations: schema.relations },
  )
}
```

## One `db` import path in Workers and Node

When a project uses **D1 inside Workers** and also needs **Node.js/Bun scripts** for seeds, backfills, or admin queries, keep **one schema file** and publish **two runtime entrypoints** with the **same exports**. Do **not** put `if (process.env...)` branches in one file. Use `package.json` export conditions instead.

This is the canonical runtime example for remote D1 access from Node.js or Bun.

**Important:** in Drizzle beta, `driver: 'd1-http'` exists in **drizzle-kit config**, but there is **no public runtime import** `drizzle-orm/d1-http`. The Drizzle repo itself handles `d1-http` in `drizzle-kit/src/cli/connections.ts` by importing `drizzle-orm/sqlite-proxy` and calling the Cloudflare D1 HTTP API with `fetch()`. So the runtime pattern for Node.js/Bun scripts should be `drizzle-orm/sqlite-proxy`, not `drizzle-orm/d1-http`.

**Rule:** Both Workers and Node entrypoints use `drizzle-orm/sqlite-proxy` as the runtime driver. Import `D1Database` as a **type only** from `drizzle-orm/d1` for typing the binding parameter. The Workers entrypoint calls D1 APIs directly via inline callbacks; the Node entrypoint calls the D1 HTTP API.

```ts
// db/src/schema.ts
import * as sqliteCore from 'drizzle-orm/sqlite-core'

export const users = sqliteCore.sqliteTable('users', {
  id: sqliteCore.text('id').primaryKey().notNull(),
  email: sqliteCore.text('email').notNull(),
})

export const relations = {}
```

```ts
// db/src/workerd.ts
import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { D1Database } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

export { schema }

// Convert D1 object rows to positional arrays for sqlite-proxy.
function d1ToRawRows(results: Record<string, unknown>[]) {
  return results.map((row) => Object.keys(row).map((k) => row[k]))
}

export function getDb(d1: D1Database = env.DB) {
  return drizzle(
    async (sql, params, method) => {
      const stmt = d1.prepare(sql).bind(...params)
      if (method === 'run') {
        await stmt.run()
        return { rows: [] as any[] }
      }
      // raw() returns positional arrays which sqlite-proxy expects.
      const rows = await stmt.raw()
      // sqlite-proxy expects a falsy value for `get` no-row results.
      // https://github.com/drizzle-team/drizzle-orm/issues/5461
      if (method === 'get') return { rows: rows[0] as any }
      return { rows: rows as any[] }
    },
    async (queries) => {
      // D1 batch() only returns objects, convert for sqlite-proxy.
      const stmts = queries.map((q) => d1.prepare(q.sql).bind(...q.params))
      const results = await d1.batch(stmts)
      return results.map((r, i) => {
        const rows = d1ToRawRows(r.results as Record<string, unknown>[])
        if (queries[i]!.method === 'get') return { rows: rows[0] as any }
        return { rows: rows as any[] }
      })
    },
    { schema, relations: schema.relations },
  )
}
```

```ts
// db/src/node.ts
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'

export { schema }

async function queryD1(sql: string, params: any[], method: string) {
  // sqlite-proxy expects positional arrays, so always use 'raw'
  // endpoint for reads. 'query' returns objects which break mapResultRow.
  const endpoint = method === 'run' ? 'query' : 'raw'
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID!}/d1/database/${process.env.CLOUDFLARE_DATABASE_ID!}/${endpoint}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.CLOUDFLARE_D1_TOKEN!}`,
      },
      body: JSON.stringify({ sql, params }),
    },
  )

  const data = await response.json() as {
    success: boolean
    errors?: { code: number; message: string }[]
    result?: { results: any[] | { rows: any[] } }[]
  }

  if (!data.success) {
    throw new Error(data.errors?.map((e) => `${e.code}: ${e.message}`).join('\n') ?? 'Unknown D1 error')
  }

  const result = data.result?.[0]?.results
  const rows = Array.isArray(result) ? result : (result?.rows ?? [])

  // sqlite-proxy expects a falsy rows value for `get` no-row results.
  // Returning [] is truthy and produces `{ id: undefined }` in findFirst.
  // https://github.com/drizzle-team/drizzle-orm/issues/5461
  if (method === 'get') return { rows: rows[0] }
  return { rows }
}

export function getDb() {
  return drizzle(
    (sql, params, method) => queryD1(sql, params, method),
    async (queries) => Promise.all(queries.map((q) => queryD1(q.sql, q.params, q.method))),
    { schema, relations: schema.relations },
  )
}
```

```json
{
  "name": "db",
  "type": "module",
  "exports": {
    ".": {
      "workerd": "./src/workerd.ts",
      "default": "./src/node.ts"
    },
    "./schema": "./src/schema.ts"
  }
}
```

Now every consumer uses the **same import path**:

```ts
import { db, schema } from 'db'
```

- In **Cloudflare Workers**, Wrangler resolves the `workerd` export
- In **Node.js/Bun scripts**, the normal/default export resolves
- `schema.ts` stays shared and isomorphic. Only the client wiring changes

If editor/type resolution in the Worker package picks the default entry instead of the `workerd` one, add this to the Worker package `tsconfig.json`:

```json
{
  "compilerOptions": {
    "customConditions": ["workerd"]
  }
}
```

## Environment variables and bindings

### Cloudflare D1

No URL needed inside Workers. Use the D1 binding from `wrangler.jsonc` via `sqlite-proxy` callbacks (see workerd.ts example in the "One db import path" section above).

### Cloudflare Hyperdrive

Connection string lives in the Cloudflare dashboard. The Worker reads it through the binding.

```ts
// db/src/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export { schema }

export function createDb(env: { HYPERDRIVE: Hyperdrive }) {
  const pool = new pg.Pool({
    connectionString: env.HYPERDRIVE.connectionString,
  })
  return drizzle(pool, { schema, relations: schema.relations })
}
```

```ts
// api/src/index.ts
import { createDb } from 'db'

export default {
  async fetch(request: Request, env: Env) {
    const db = createDb(env)
    // ...
  },
}
```

## Driver setup

Docs: D1 https://orm.drizzle.team/docs/connect-cloudflare-d1 | Durable Objects https://orm.drizzle.team/docs/connect-cloudflare-do | Turso https://orm.drizzle.team/docs/connect-turso | All drivers https://orm.drizzle.team/docs/connect-overview

### Cloudflare D1

D1 is Cloudflare's managed SQLite database. It's the simplest option for Cloudflare Workers. No Durable Objects, no proxy layers. Use `drizzle-orm/sqlite-proxy` with inline D1 callbacks as shown above (NOT `drizzle-orm/d1` which has batch bugs).

**Prefer D1 over Durable Objects** for new projects unless you specifically need DO features like single-point-of-serialization, WebSocket hibernation, or PITR.

**drizzle.config.ts:**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: './src/schema.ts',
  dialect: 'sqlite',
  // No `driver` field for D1
})
```

**wrangler.jsonc:**

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "<id-from-wrangler-d1-create>",
      "migrations_dir": "./drizzle",
      "migrations_pattern": "drizzle/*/migration.sql"
    }
  ]
}
```

The `migrations_pattern` glob tells wrangler to discover migrations inside drizzle-kit's nested subdirectories (`drizzle/0001_some_name/migration.sql`). Without it, wrangler only looks for top-level `.sql` files. The pattern **must start with** the `migrations_dir` value. Each migration's name is recorded in the `d1_migrations` table as the path relative to `migrations_dir` (e.g. `0001_some_name/migration.sql`).

**Creating D1 databases:**

```bash
wrangler d1 create my-app-db
wrangler d1 create my-app-preview-db
```

### D1 migrations: use drizzle-kit generate directly

Since **wrangler 4.98.0**, D1 supports nested migration layouts via `migrations_pattern`. Drizzle-kit's default output (`drizzle/timestamp_name/migration.sql` subdirectories) works directly with D1; no flattening or post-processing is needed.

Drizzle-orm does not read migration files at runtime; D1 tracks applied migrations via `wrangler d1 migrations apply`.

**Workflow:**

1. Edit `schema.ts`
2. Run `drizzle-kit generate`
3. Review the generated SQL in `drizzle/timestamp_name/migration.sql`; edit if needed (add comments, data migrations, simplify SQLite ALTER TABLE sequences)
4. Apply with `wrangler d1 migrations apply`

If `drizzle-kit generate` fails (interactive prompts on renames, TTY errors in CI), write the migration SQL directly. Read existing migration files and `schema.ts` to understand the current and desired state.

D1 splits statements on **semicolons** like any SQL parser. The `--> statement-breakpoint` comments in drizzle-kit output are just visual separators that D1 ignores; you can keep or remove them.

**Existing projects using the flat-file hack:** if the project already has flat `.sql` files (e.g. `0001_init.sql`) from a previous flattening workflow, **keep using flat files for that project**. Switching to `migrations_pattern` mid-project requires renaming every entry in the `d1_migrations` table to match the new nested paths, otherwise wrangler tries to re-apply all migrations. The risk of getting that wrong is not worth the convenience. Only use `migrations_pattern` for new projects or projects that have never applied flat migrations to D1.

#### Apply migrations

```bash
wrangler d1 migrations apply DB --remote
wrangler d1 migrations apply DB --remote --env preview
wrangler d1 migrations apply DB --local
```

> **IMPORTANT: Cloudflare D1 does NOT auto-apply migrations on deploy.** Always run migrations before deploying. Bake them into deploy scripts so they can't be skipped. If you deploy new worker code that references columns or tables from a pending migration, the worker will crash with "no such table" or "no such column" errors.

> **Always deploy preview first, then production.** D1 migrations can fail (bad SQL, constraint violations on existing data) and there is no automatic rollback. Running against preview first catches these failures safely. If preview migration fails, **stop** and do not continue to production.

Bake migrations into deploy scripts. The remote migration scripts print a unix timestamp before running so you can restore via D1 time travel if something goes wrong:

```json
{
  "scripts": {
    "db:migrate:local": "wrangler d1 migrations apply DB --local",
    "db:migrate:prod": "echo \"D1 pre-migration timestamp: $(date +%s)\" && wrangler d1 migrations apply DB --remote",
    "db:migrate:preview": "echo \"D1 pre-migration timestamp: $(date +%s)\" && wrangler d1 migrations apply DB --remote --env preview",
    "deploy": "pnpm db:migrate:preview && CLOUDFLARE_ENV=preview vite build && wrangler deploy --env preview",
    "deploy:prod": "pnpm db:migrate:prod && vite build && wrangler deploy"
  }
}
```

If a migration corrupts data, use the printed timestamp to restore via D1 time travel:

```bash
wrangler d1 time-travel restore DB --timestamp=<unix_timestamp>
wrangler d1 time-travel restore DB --timestamp=<unix_timestamp> --env preview
```

### Running scripts against D1 outside Workers

Use the canonical `db/src/node.ts` `sqlite-proxy` example above to talk to remote D1 databases from Node.js/Bun scripts.

Do **not** write `import { drizzle } from 'drizzle-orm/d1-http'` in runtime code. In Drizzle beta, that path is **not** a public `drizzle-orm` export. `d1-http` is a **drizzle-kit driver name**, not a runtime import path.

**Required environment variables:**

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_DATABASE_ID`
- `CLOUDFLARE_D1_TOKEN`

If the tool also needs account metadata, add `Account - Account Settings - Read` to the token too.

```bash
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_DATABASE_ID=... \
CLOUDFLARE_D1_TOKEN=... \
pnpm tsx scripts/backfill-users.ts
```

```ts
// scripts/backfill-users.ts
import { db, schema } from 'db'

const existingUsers = await db.query.users.findMany()
console.log('users', existingUsers.length)

await db.insert(schema.users).values({
  id: crypto.randomUUID(),
  email: 'seed@example.com',
})
```

This is why the conditional-exports pattern above matters. The script imports the **same `db` symbol** as Worker code. Both entrypoints use `drizzle-orm/sqlite-proxy`; the Workers one calls D1 APIs directly while the Node one calls the D1 HTTP API.

The empty-row `get` edge case also lives in that canonical example. Keep the `undefined` return for no-row `get` results so `findFirst()` does not produce malformed objects. See https://github.com/drizzle-team/drizzle-orm/issues/5461.

The same env vars also work well for `drizzle-kit studio`, `drizzle-kit pull`, or other local admin scripts that talk to remote D1.

For local scripts against local D1, use `wrangler d1 execute DB --local --command "..."` or connect directly to `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` via `better-sqlite3`.

**Batch support:** D1 natively supports `db.batch()`.

```ts
const db = getDb()
const [users, posts] = await db.batch([
  db.query.users.findMany(),
  db.query.posts.findMany({ where: { status: 'published' } }),
])
```

### Migrating from Durable Objects to D1

If switching an existing worker from DO to D1:

1. Create D1 databases with `wrangler d1 create`
2. Keep `drizzle-orm/sqlite-proxy` in `db.ts` but change the callbacks from DO RPC to direct D1 binding calls (see workerd.ts example above)
3. Replace `durable_objects` bindings with `d1_databases` in `wrangler.jsonc`
4. Add a `deleted_classes` migration tag to remove old DO classes
5. Delete the DO class file, remove its export from `app.tsx`
6. Remove `driver: 'durable-sqlite'` from `drizzle.config.ts`
7. Remove `.sql` text-import rules if no longer needed
8. Regenerate types with `wrangler types`

### Cloudflare Durable Objects via sqlite-proxy

The DO should be a **thin SQL proxy**. It owns the SQLite database, runs migrations, and exposes `executeSql()` RPC methods. All business logic stays in the worker. The worker uses `drizzle-orm/sqlite-proxy`.

**Why not `drizzle-orm/durable-sqlite` directly?** That would force your Drizzle client and business logic into the DO class.

Problems:

- passing `Request` objects over RPC can lock streams
- the DO becomes a monolith
- auth libraries that want a Drizzle instance must run inside the DO

With `sqlite-proxy`, only raw SQL crosses the RPC boundary.

**Step 1 — Thin DO:**

```ts
// src/store.ts
import { DurableObject } from 'cloudflare:workers'
import * as durable from 'drizzle-orm/durable-sqlite'
import * as migrator from 'drizzle-orm/durable-sqlite/migrator'
// @ts-expect-error — generated by drizzle-kit
import migrations from '../drizzle/migrations.js'
import * as schema from './schema.ts'

export class Store extends DurableObject<Env> {
  db: durable.DrizzleSqliteDODatabase<typeof schema, typeof schema.relations>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db = durable.drizzle(ctx.storage, { schema, relations: schema.relations })
    ctx.blockConcurrencyWhile(async () => {
      await migrator.migrate(this.db, migrations)
    })
  }

  private execOne(sql: string, params: unknown[], method: string) {
    const stmt = this.ctx.storage.sql.exec(sql, ...params)
    const columnNames = stmt.columnNames
    const rawRows = stmt.toArray()

    if (method === 'get') {
      const row = rawRows[0]
      // MUST return { rows: null } here because Cloudflare RPC structured clone
      // drops undefined. sqlite-proxy still needs a falsy value.
      // https://github.com/drizzle-team/drizzle-orm/issues/5461
      if (!row) return { rows: null }
      return { rows: columnNames.map((col) => (row as Record<string, unknown>)[col]) }
    }

    const rows = rawRows.map((row) =>
      columnNames.map((col) => (row as Record<string, unknown>)[col]),
    )
    return { rows }
  }

  async executeSql(sql: string, params: unknown[], method: string) {
    return this.execOne(sql, params, method)
  }

  async executeSqlBatch(batch: { sql: string; params: unknown[]; method: string }[]) {
    return batch.map((q) => this.execOne(q.sql, q.params, q.method))
  }
}
```

**Step 2 — Worker-side sqlite-proxy client:**

```ts
// src/db.ts
import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'
import type { Store } from './store.ts'

function getStub() {
  const id = env.MY_STORE.idFromName('main')
  return env.MY_STORE.get(id) as DurableObjectStub<Store>
}

export function getDb() {
  const stub = getStub()
  return drizzle(
    async (sql, params, method) => stub.executeSql(sql, params, method) as any,
    async (batch) => stub.executeSqlBatch(batch) as any,
    { schema, relations: schema.relations },
  )
}
```

**drizzle.config.ts:**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: './src/schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
})
```

**wrangler.jsonc:**

```jsonc
{
  "rules": [
    { "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }
  ],
  "durable_objects": {
    "bindings": [{ "name": "MY_STORE", "class_name": "Store" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Store"] }
  ]
}
```

### Cloudflare Hyperdrive

```ts
// db/src/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export { schema }

export function createDb(env: { HYPERDRIVE: Hyperdrive }) {
  const pool = new pg.Pool({
    connectionString: env.HYPERDRIVE.connectionString,
  })
  return drizzle(pool, { schema, relations: schema.relations })
}
```

**Disable Hyperdrive caching** when stale reads are unacceptable:

```bash
npx wrangler hyperdrive update YOUR_HYPERDRIVE_ID --caching-disabled true
```

**Worker placement:** colocate the worker with the database.

```json
{
  "placement": { "mode": "smart" },
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "YOUR_HYPERDRIVE_ID" }
  ]
}
```

**drizzle.config.ts:**

```ts
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
```

## SQLite enums are safe to extend

In SQLite, `text('status', { enum: ['a', 'b', 'c'] })` does **not** generate a `CHECK` constraint. The enum is purely a TypeScript type hint. Adding a new value to the array produces no migration at all, or at most a no-op snapshot update. No table recreate, no data copy.

This means enums are safe and cheap to evolve over time on D1 and SQLite. Prefer them over plain `text().$type<...>()` because the enum values are discoverable in the schema definition and Drizzle uses them for type inference and Zod generation.

## Cloudflare-specific migrations notes

### Apply migrations to D1

Use Wrangler, not `drizzle-kit migrate`. See the "D1 migrations" section above for the full manual migration workflow.

```bash
wrangler d1 migrations apply DB --remote
wrangler d1 migrations apply DB --remote --env preview
wrangler d1 migrations apply DB --local
```

### Durable Objects migrations

For DO, write migration `.sql` files manually and also update `migrations.js` with the new import entry. Apply in the thin DO constructor:

```ts
import * as durable from 'drizzle-orm/durable-sqlite'
import * as migrator from 'drizzle-orm/durable-sqlite/migrator'
import migrations from '../drizzle/migrations.js'

this.db = durable.drizzle(ctx.storage, { schema, relations: schema.relations })
ctx.blockConcurrencyWhile(async () => {
  await migrator.migrate(this.db, migrations)
})
```

The `durable-sqlite` driver is only used inside the DO for migrations. All query execution goes through `executeSql()` RPC plus `drizzle-orm/sqlite-proxy` in the worker.

## Durable Objects as an external database

Docs: libsqlproxy https://github.com/remorses/kimaki/tree/main/libsqlproxy | CF PITR https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api

Durable Objects with SQLite can also be exposed externally through the libsql wire protocol.

### libsqlproxy

`pnpm add libsqlproxy` and read the full setup guide at https://github.com/remorses/kimaki/tree/main/libsqlproxy

**How it works:**

- inside the DO, `createLibsqlHandler(durableObjectExecutor(ctx.storage))` bridges Hrana v2 to `ctx.storage.sql`
- in the worker, `createLibsqlProxy()` validates `namespace:secret` auth tokens and forwards to the correct DO stub
- usually wants a dedicated hostname like `libsql.example.com`

```ts
import { createClient } from '@libsql/client'

const client = createClient({
  url: 'https://libsql.example.com',
  authToken: 'my-do-id:my-shared-secret',
})

await client.execute('SELECT * FROM accounts')
```

### Point-in-Time Recovery

Cloudflare provides PITR for SQLite-backed Durable Objects. Restore to any point in the last 30 days.

```ts
const bookmark = await this.ctx.storage.getCurrentBookmark()
const twoDaysAgo = await this.ctx.storage.getBookmarkForTime(Date.now() - 2 * 24 * 60 * 60 * 1000)
await this.ctx.storage.onNextSessionRestoreBookmark(twoDaysAgo)
this.ctx.abort()
```

Expose a restore endpoint:

```ts
async restore(timestamp: number) {
  const undoBookmark = await this.ctx.storage.getCurrentBookmark()
  const bookmark = await this.ctx.storage.getBookmarkForTime(timestamp)
  await this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
  this.ctx.abort()

  return { undoBookmark, restoredTo: bookmark }
}
```

PITR restores the entire SQLite database, both SQL tables and KV data. It is not available in local development.

## Memoizing drizzle queries at the edge

Workers run globally on 300+ datacenters, but D1 lives in one region. Cross-region reads can be 50-200ms. Use the `memoize()` utility bundled with this skill (`./worker-memoize.ts`) to cache drizzle query results at the edge via the Cloudflare Cache API. Reads from cache are ~1-5ms.

Copy `./worker-memoize.ts` into your project as `lib/memoize.ts`. Dependencies: `superjson`, `cloudflare:workers`, `spiceflow`.

```ts
import { memoize } from './lib/memoize.ts'

// Defaults: 5 min fresh, 10 min stale-while-revalidate
const getOrgIdForProject = memoize({
  namespace: 'project-org',
  fn: async (projectId: string) => {
    const db = getDb()
    const row = await db.query.project.findFirst({
      where: { id: projectId },
      columns: { orgId: true },
    })
    return row?.orgId ?? null // null/undefined = not cached
  },
})
```

**null, undefined, and Error results are never cached.** Functions must return null/undefined or throw for "not found" / auth failure cases so those results don't get cached and lock users out. See the `cloudflare-workers` skill for the full memoize documentation and what to memoize vs skip.
