---
name: drizzle
description: >
  Drizzle ORM conventions and best practices for TypeScript projects.
  Covers namespace imports, Prisma-like query API, object-style where
  filters, schema design (ULIDs, cascade deletes, indexes, enums over bools),
  Zod schema generation, type inference, transactions, migrations, and
  driver setup for Cloudflare Durable Objects (via sqlite-proxy),
  libSQL/Turso, and Postgres via Hyperdrive.
  ALWAYS load this skill when a repo uses drizzle-orm.
---

# Drizzle ORM

Drizzle ORM conventions for all my TypeScript projects.

## CRITICAL: Always use drizzle beta, NEVER v0

Always install `drizzle-orm@beta` and `drizzle-kit@beta` (currently 1.0.0-beta.x). NEVER use `drizzle-orm@latest` which resolves to v0.x — it lacks `defineRelations`, 2-param `DrizzleSqliteDODatabase`, and other v1 features used throughout this skill.

```bash
pnpm install drizzle-orm@beta
pnpm install drizzle-kit@beta --save-dev
```

**Docs reference:** https://orm.drizzle.team/llms.txt — full docs index for LLMs. Fetch this when you need to look up something not covered here.

## Project structure

In projects with multiple packages (monorepos), put all database code in a dedicated `db` package at the workspace root. Read the `npm-package` skill for how to set up the package with proper `package.json`, `tsconfig.json`, exports, and build.

```
my-project/
  db/                        # the db package
    src/
      schema.ts              # tables + relations
      index.ts               # exports drizzle client, schema, types
    drizzle/                  # generated migrations
    drizzle.config.ts
    package.json              # name: "db", exports: { ".": "./src/index.ts" }
  api/                        # worker / server package
    src/
      index.ts                # imports from "db"
    package.json              # dependencies: { "db": "workspace:^" }
  pnpm-workspace.yaml         # packages: [db, api, ...]
```

The `db` package owns:
- **Schema** (`src/schema.ts`) — tables, relations, types
- **Migrations** (`drizzle/`) — generated SQL files
- **Drizzle client** (`src/index.ts`) — exported `db` instance or factory function
- **drizzle.config.ts** — dialect, schema path, migrations output

Other packages import from `db` directly:

```ts
import { db, schema } from 'db'
// or for environments needing runtime bindings (Hyperdrive, DO):
import { createDb, schema } from 'db'
```

For single-package projects, put schema at `src/schema.ts` (not in a `db/` subfolder).

### What the db package exports

For environments where the connection is static (libSQL, direct Postgres):

```ts
// db/src/index.ts
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

export { schema }
export type { relations } from './schema.ts'

export const db = drizzle({
  connection: {
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN!,
  },
  schema,
  relations: schema.relations,
})
```

For environments where the connection depends on runtime bindings (Cloudflare Hyperdrive, DO):

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

## Namespace imports

Always use namespace imports to avoid polluting local scope with generic names like `eq`, `and`, `gt`, `text`, `integer`:

```ts
import * as orm from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import * as pgCore from 'drizzle-orm/pg-core'

// use orm.eq, orm.and, sqliteCore.sqliteTable, etc.
```

Never destructure — `import { eq, and, text } from 'drizzle-orm'` is banned.

## Relations definition (v2)

Docs: https://orm.drizzle.team/docs/relations-v2 | Migration guide: https://orm.drizzle.team/docs/relations-v1-v2

Define relations in the same file as your schema using `defineRelations`. Pass the tables as an object:

```ts
// src/schema.ts
import { defineRelations } from 'drizzle-orm'

// ... table definitions ...

export const relations = defineRelations({ accounts, boards }, (r) => ({
  accounts: {
    boards: r.many.boards(),
  },
  boards: {
    account: r.one.accounts({
      from: r.boards.accountId,
      to: r.accounts.id,
    }),
  },
}))
```

Pass both `schema` and `relations` to `drizzle()`:

**Many-to-many** — use a junction table with cascade deletes on both FKs, and `through` in relations:

```ts
// Tables
const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  name: text('name').notNull(),
})

const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  name: text('name').notNull(),
})

// Junction table — cascade both sides so deleting a user or org cleans up memberships
const orgUsers = sqliteTable('org_users', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('org_users_user_id_idx').on(table.userId),
  index('org_users_org_id_idx').on(table.orgId),
])

// Relations — both sides get many-to-many via through
export const relations = defineRelations({ users, orgs, orgUsers }, (r) => ({
  users: {
    orgs: r.many.orgs({
      from: r.users.id.through(r.orgUsers.userId),
      to: r.orgs.id.through(r.orgUsers.orgId),
    }),
  },
  orgs: {
    users: r.many.users({
      from: r.orgs.id.through(r.orgUsers.orgId),
      to: r.users.id.through(r.orgUsers.userId),
    }),
  },
}))
```

Query usage:

```ts
// Get user with all their orgs
const user = await db.query.users.findFirst({
  where: { id: userId },
  with: { orgs: true },
})

// Get org with all members
const org = await db.query.orgs.findFirst({
  where: { id: orgId },
  with: { users: true },
})
```

## Query API (Prisma-like)

Docs: https://orm.drizzle.team/docs/rqb-v2 | Filters: https://orm.drizzle.team/docs/operators

**Reads: always use `db.query`** — the relational query API with **object-style `where`**. Never use `db.select().from()` for reads.

```ts
// Simple equality — just pass the value
const user = await db.query.accounts.findFirst({
  where: { refreshToken: someToken },
})

// Multiple conditions (implicit AND)
const accounts = await db.query.accounts.findMany({
  where: { status: 'active', workspaceId: 'ws_123' },
})

// Complex filters with operators
const posts = await db.query.posts.findMany({
  where: {
    AND: [
      { authorId: userId },
      { createdAt: { gt: cutoff } },
    ],
  },
  with: {
    comments: true,
    author: true,
  },
  orderBy: { createdAt: 'desc' },
  limit: 20,
})

// OR conditions
const results = await db.query.accounts.findMany({
  where: {
    OR: [
      { status: 'active' },
      { name: { like: 'John%' } },
    ],
  },
})

// Filter by relations (v2 only!)
const usersWithPosts = await db.query.users.findMany({
  where: {
    id: { gt: 10 },
    posts: { content: { like: 'M%' } },
  },
})
```

**Key rules:**

- Use **object-style `where`** — no operator imports needed. Pass values directly for equality, use `{ gt: }`, `{ like: }`, `{ in: }` etc. for operators
- Use `AND`, `OR`, `NOT` for logical combinations
- Use `with` to include relations (like Prisma's `include`)
- Use `orderBy` as object: `{ createdAt: 'desc' }`
- Use `findFirst` (adds `LIMIT 1`) or `findMany`

**Writes: use `db.insert`, `db.update`, `db.delete`** — no query API for writes.

```ts
// For write .where() clauses, use orm.eq since there is no object-style where for writes
await db.update(schema.accounts)
  .set({ accessToken: newToken, updatedAt: Date.now() })
  .where(orm.eq(schema.accounts.id, accountId))
```

## CRUD examples

Docs: Insert https://orm.drizzle.team/docs/insert | Update https://orm.drizzle.team/docs/update | Delete https://orm.drizzle.team/docs/delete | Upsert https://orm.drizzle.team/docs/guides/upsert

All examples below show both SQLite and Postgres when the syntax differs.

### Insert

```ts
// Single insert with returning (same for SQLite and Postgres)
const [newAccount] = await db.insert(schema.accounts)
  .values({
    name: 'John',
    email: 'john@example.com',
    status: 'active',
    createdAt: Date.now(),     // SQLite: epoch ms
    // createdAt: new Date(),  // Postgres: Date object (or use .defaultNow())
  })
  .returning()

// Bulk insert — pass an array
await db.insert(schema.accounts)
  .values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ])
  .returning()
```

### Read with relations

```ts
// Find one account with all its boards
const account = await db.query.accounts.findFirst({
  where: { id: accountId },
  with: {
    boards: true,
  },
})

// Find many with nested relations, filtering, ordering
const accounts = await db.query.accounts.findMany({
  where: {
    status: 'active',
    createdAt: { gt: cutoffDate },
  },
  with: {
    boards: {
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      limit: 10,
    },
  },
  orderBy: { name: 'asc' },
  limit: 50,
})
```

### Update

```ts
// Update by condition — same for SQLite and Postgres
await db.update(schema.accounts)
  .set({ name: 'New Name', updatedAt: Date.now() })
  .where(orm.eq(schema.accounts.id, accountId))

// Update with returning (get back the updated row)
const [updated] = await db.update(schema.accounts)
  .set({ status: 'archived' })
  .where(orm.eq(schema.accounts.id, accountId))
  .returning()
```

### Delete

```ts
// Delete by condition
await db.delete(schema.boards)
  .where(orm.eq(schema.boards.id, boardId))

// Delete with returning (get back the deleted row)
const [deleted] = await db.delete(schema.boards)
  .where(orm.eq(schema.boards.id, boardId))
  .returning()
```

With `onDelete: 'cascade'` on foreign keys, deleting a parent automatically deletes all children:

```ts
// Deleting an account cascades to all its boards
await db.delete(schema.accounts)
  .where(orm.eq(schema.accounts.id, accountId))
```

### Upsert (insert or update on conflict)

Syntax is the same for SQLite and Postgres — both use `ON CONFLICT DO UPDATE`:

```ts
// Upsert by primary key
await db.insert(schema.accounts)
  .values({
    id: accountId,
    name: 'John',
    email: 'john@example.com',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  .onConflictDoUpdate({
    target: schema.accounts.id,
    set: {
      name: 'John',
      email: 'john@example.com',
      updatedAt: Date.now(),
    },
  })
```

**Upsert by unique column:**

```ts
await db.insert(schema.accounts)
  .values({
    notionUserId: 'notion_123',
    name: 'John',
    accessToken: newToken,
    refreshToken: newRefreshToken,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  .onConflictDoUpdate({
    target: schema.accounts.notionUserId,
    set: {
      name: 'John',
      accessToken: newToken,
      refreshToken: newRefreshToken,
      updatedAt: Date.now(),
    },
  })
  .returning()
```

**Upsert with `excluded` — use the proposed values dynamically:**

```ts
import { sql } from 'drizzle-orm'

// When upserting multiple rows, use `excluded` to reference the proposed value
await db.insert(schema.accounts)
  .values(accountsToUpsert)
  .onConflictDoUpdate({
    target: schema.accounts.notionUserId,
    set: {
      name: sql`excluded.name`,
      accessToken: sql`excluded.access_token`,
      updatedAt: sql`excluded.updated_at`,
    },
  })
```

**Upsert with composite unique key:**

```ts
await db.insert(schema.usersToGroups)
  .values({ userId: 1, groupId: 5 })
  .onConflictDoUpdate({
    target: [schema.usersToGroups.userId, schema.usersToGroups.groupId],
    set: { assignedAt: Date.now() },
  })
```

**Upsert with conditional update (Postgres & SQLite):**

```ts
// Only update if existing row is older
await db.insert(schema.accounts)
  .values(newAccount)
  .onConflictDoUpdate({
    target: schema.accounts.id,
    set: { name: sql`excluded.name`, updatedAt: sql`excluded.updated_at` },
    setWhere: sql`${schema.accounts.updatedAt} < excluded.updated_at`,
  })
```

**Insert or ignore (do nothing on conflict):**

```ts
await db.insert(schema.accounts)
  .values({ id: accountId, name: 'John' })
  .onConflictDoNothing({ target: schema.accounts.id })
```

## Type inference

Docs: https://orm.drizzle.team/docs/goodies

Derive types directly from the schema — never define separate interfaces:

```ts
// Select type (what you get back from queries)
type Account = typeof schema.accounts.$inferSelect

// Insert type (what you pass to db.insert)
type NewAccount = typeof schema.accounts.$inferInsert

// Use in function signatures
function processAccount(account: typeof schema.accounts.$inferSelect) { ... }
```

## Zod schema generation

Docs: https://orm.drizzle.team/docs/zod

Install `drizzle-zod` to generate runtime validation schemas from your Drizzle tables. Useful for API route input/output validation (e.g. spiceflow `request`/`response`):

```ts
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod'

const insertAccountSchema = createInsertSchema(schema.accounts)
const selectAccountSchema = createSelectSchema(schema.accounts)

// Override or refine fields
const createBoardInput = createInsertSchema(schema.boards, {
  trackedRepos: z.array(z.string()),  // override text → proper array
})

// Use in spiceflow route
app.route({
  method: 'POST',
  path: '/api/boards',
  request: createBoardInput.omit({ id: true, createdAt: true }),
  response: selectBoardSchema.pick({ id: true }),
  async handler({ request }) { ... },
})
```

## Schema best practices

Docs: https://orm.drizzle.team/docs/sql-schema-declaration | Indexes: https://orm.drizzle.team/docs/indexes-constraints

### File location

Put schema at `src/schema.ts` (not in a `db/` subfolder). In monorepos, this lives inside the `db` package. For large projects split by domain: `src/schema-users.ts`, `src/schema-posts.ts`, then re-export from `src/schema.ts`.

### ULID IDs

Use ULID for primary keys — sortable, unique, human-readable, no collisions:

```ts
import { ulid } from 'ulid'

const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  // ...
})
```

For Postgres:

```ts
const accounts = pgTable('accounts', {
  id: pgCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  // ...
})
```

### Foreign keys with cascade delete

Always set `onDelete: 'cascade'` on child references so deleting a parent cleans up children:

```ts
accountId: text('account_id')
  .notNull()
  .references(() => accounts.id, { onDelete: 'cascade' }),
```

### Always define relations — both sides

Even if you only query one direction. This enables `db.query` `with` nesting. Define at the bottom of the same schema file:

```ts
// at the bottom of src/schema.ts
export const relations = defineRelations({ accounts, boards }, (r) => ({
  accounts: {
    boards: r.many.boards(),
  },
  boards: {
    account: r.one.accounts({
      from: r.boards.accountId,
      to: r.accounts.id,
    }),
  },
}))
```

### Index every FK column

Drizzle does not auto-index foreign keys. Add explicit indexes:

```ts
const boards = sqliteTable('boards', {
  id: text('id').primaryKey().notNull(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  // ...
}, (table) => [
  index('boards_account_id_idx').on(table.accountId),
])
```

### Enums over booleans

Booleans are not extensible. Use enums:

```ts
// BAD
isActive: integer('is_active', { mode: 'boolean' }),
isArchived: integer('is_archived', { mode: 'boolean' }),

// GOOD — one column, extensible, self-documenting
status: text('status', { enum: ['active', 'archived', 'suspended'] }).notNull().default('active'),
```

For Postgres use `pgEnum`:

```ts
const statusEnum = pgCore.pgEnum('status', ['active', 'archived', 'suspended'])

const accounts = pgTable('accounts', {
  status: statusEnum('status').notNull().default('active'),
})
```

### Tables over JSON blobs

Never store structured domain data as `JSON.stringify()` in a text column. Create proper relational tables instead — you get type safety, indexes, foreign keys, query filtering.

```ts
// BAD — loses all type safety, can't query/index/constrain
trackedRepos: text('tracked_repos').notNull().default('[]'),
// usage: JSON.parse(row.trackedRepos) as string[]  // unsafe cast

// GOOD — proper table with foreign key, indexable, type-safe
const trackedRepos = sqliteTable('tracked_repos', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  repoUrl: text('repo_url').notNull(),
}, (table) => [
  index('tracked_repos_board_id_idx').on(table.boardId),
])
```

Exception: truly unstructured/opaque data (raw API responses for debugging) can be JSON. But never domain data you query or filter on.

### Timestamps

SQLite: `integer('created_at', { mode: 'number' })` storing `Date.now()` (epoch ms).
Postgres: `pgCore.timestamp('created_at').defaultNow().notNull()`.

### Column naming

Always snake_case for database column names: `created_at`, `account_id`, `notion_user_id`.

## Database URL & environment variables

### Postgres

Use `DATABASE_URL` env var. Format: `postgresql://user:pass@host:5432/dbname`

```ts
// db/drizzle.config.ts
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
```

### libSQL / Turso

Use `DATABASE_URL` + `DATABASE_AUTH_TOKEN`:

```ts
// db/src/index.ts
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

export { schema }

export const db = drizzle({
  connection: {
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN!,
  },
  schema,
  relations: schema.relations,
})
```

### Cloudflare (D1, Durable Objects)

No URL needed — bindings in `wrangler.json`.

```ts
// D1
import { drizzle } from 'drizzle-orm/d1'
const db = drizzle(env.DB, { schema, relations: schema.relations })

// Durable Objects — see "Driver setup > Cloudflare Durable Objects" below
```

### Cloudflare Hyperdrive (Postgres)

Connection string lives in Cloudflare dashboard. Worker accesses via binding. Export a factory from the db package:

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

### Running scripts via Doppler

For migrations, seeds, one-off scripts — use `doppler run` to inject secrets without `.env` files:

```bash
# Run from the db package directory
doppler run -- pnpm drizzle-kit migrate
doppler run -- pnpm drizzle-kit push
doppler run -- pnpm drizzle-kit studio

# Generate migrations (reads schema, no DB connection needed for SQLite)
pnpm drizzle-kit generate
```

In the db package's `package.json`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "doppler run -- drizzle-kit migrate",
    "db:push": "doppler run -- drizzle-kit push",
    "db:studio": "doppler run -- drizzle-kit studio"
  }
}
```

## Driver setup

Docs: Durable Objects https://orm.drizzle.team/docs/connect-cloudflare-do | Turso https://orm.drizzle.team/docs/connect-turso | D1 https://orm.drizzle.team/docs/connect-cloudflare-d1 | All drivers https://orm.drizzle.team/docs/connect-overview

### Cloudflare Durable Objects (SQLite via sqlite-proxy)

The DO is a **thin SQL proxy** — it only owns the SQLite database, runs migrations, and exposes an `executeSql()` RPC method. All business logic (auth, CRUD, encryption) runs in the worker and uses `drizzle-orm/sqlite-proxy` to route queries to the DO via RPC.

**Why not `drizzle-orm/durable-sqlite` directly?** Using the durable-sqlite driver means your drizzle client lives inside the DO class, forcing all business logic (auth libraries, encryption, CRUD) into RPC methods. This causes problems:
- Passing `Request` objects over RPC can lock `ReadableStream` bodies
- The DO becomes a monolith — every query requires a separate RPC method
- Libraries like BetterAuth that need a drizzle instance must run inside the DO

With sqlite-proxy, the drizzle client lives in the worker. Only raw SQL strings cross the RPC boundary.

**Step 1 — Thin DO (migrations + executeSql):**

```ts
// src/store.ts — the Durable Object
import { DurableObject } from 'cloudflare:workers'
import * as durable from 'drizzle-orm/durable-sqlite'
import * as migrator from 'drizzle-orm/durable-sqlite/migrator'
// @ts-expect-error — migrations.js is generated by drizzle-kit
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

  // RPC: execute SQL on the DO's SQLite database.
  // Called by drizzle-orm/sqlite-proxy in the worker.
  async executeSql(sql: string, params: unknown[], method: string) {
    const stmt = this.ctx.storage.sql.exec(sql, ...params)
    const columnNames = stmt.columnNames
    const rawRows = stmt.toArray()

    if (method === 'get') {
      const row = rawRows[0]
      if (!row) return { rows: [] }
      return { rows: columnNames.map((col) => (row as Record<string, unknown>)[col]) }
    }

    const rows = rawRows.map((row) =>
      columnNames.map((col) => (row as Record<string, unknown>)[col]),
    )
    return { rows }
  }
}
```

**Step 2 — Worker-level drizzle client via sqlite-proxy:**

```ts
// src/db.ts — runs in the worker, NOT in the DO
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
  return drizzle(async (sql, params, method) => {
    return stub.executeSql(sql, params, method)
  }, { schema, relations: schema.relations })
}
```

**Step 3 — Use the drizzle client anywhere in the worker:**

```ts
// src/app.ts — worker routes, server actions, etc.
import { getDb } from './db.ts'
import * as schema from './schema.ts'

// Reads — use db.query (async, NOT .sync())
const user = await db.query.users.findFirst({
  where: { id: userId },
  with: { orgs: true },
})

// Writes — use db.insert/update/delete
const [project] = await db.insert(schema.project)
  .values({ name: 'My Project', orgId })
  .returning({ id: schema.project.id })
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

**wrangler.json** must include the rules to import `.sql` files as text:

```json
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

### libSQL / Turso

```ts
// db/src/index.ts
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

export { schema }

export const db = drizzle({
  connection: {
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN!,
  },
  schema,
  relations: schema.relations,
})
```

**drizzle.config.ts:**

```ts
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
})
```

### Postgres via Cloudflare Hyperdrive

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

**Disable Hyperdrive caching** (critical for writes-heavy apps or when stale reads are unacceptable):

```bash
npx wrangler hyperdrive update YOUR_HYPERDRIVE_ID --caching-disabled true
```

**Worker region placement** — colocate with your database:

```json
// wrangler.json
{
  "placement": { "mode": "smart" },
  // or explicit: "placement": { "region": "aws:us-east-1" }
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

## Transactions & batching

Docs: Transactions https://orm.drizzle.team/docs/transactions | Batch https://orm.drizzle.team/docs/batch-api

### Always use `db.batch()`, avoid `db.transaction()`

**Never use `db.transaction()`.** It holds an open database transaction across multiple round-trips — one per statement. This causes serious problems in production:
- Transactions last too long (each statement waits for a network round-trip before the next one starts)
- They hog database connections and locks, starving other requests
- They fail frequently even at low RPS because of lock contention and timeouts
- On serverless/edge (Cloudflare Workers, Vercel), cold starts make it even worse

**Use `db.batch()` instead.** It sends all statements in a single HTTP request. The database wraps them in an implicit transaction (BEGIN → statements → COMMIT). If any statement fails, the whole batch rolls back. Same atomicity guarantees, zero round-trip overhead.

```ts
const [newUsers, updatedPosts, allComments] = await db.batch([
  db.insert(users).values({ name: 'Alice' }).returning(),
  db.update(posts).set({ status: 'published' }).where(orm.eq(posts.id, 1)),
  db.query.comments.findMany(),
])
```

Statements execute **in order** inside one transaction, so statement 2 sees data that statement 1 inserted. The only limitation is you can't use the **return value** of statement 1 to build statement 2 in your TS code (all queries are defined upfront as an array). If you truly need to chain return values, do two separate batch calls — still better than holding a transaction open.

## Migrations & SQL export

Docs: Overview https://orm.drizzle.team/docs/kit-overview | Generate https://orm.drizzle.team/docs/drizzle-kit-generate | Migrate https://orm.drizzle.team/docs/drizzle-kit-migrate | Push https://orm.drizzle.team/docs/drizzle-kit-push | Export https://orm.drizzle.team/docs/drizzle-kit-export | Config https://orm.drizzle.team/docs/drizzle-config-file

### Generate migration files

```bash
pnpm drizzle-kit generate
```

Creates numbered `.sql` files in the `out` directory (e.g. `./drizzle/0000_dear_lord_tyger.sql`).

### Apply migrations

```bash
# Apply to database (Postgres, libSQL)
doppler run -- pnpm drizzle-kit migrate

# Dev only — push schema directly, no migration files
doppler run -- pnpm drizzle-kit push
```

### Export full schema as single SQL file

`drizzle-kit export` outputs the complete DDL to stdout. Pipe to a file:

```bash
pnpm drizzle-kit export > schema.sql
```

This is useful for:
- Embedded migrations in SQLite (bundling with Durable Objects)
- Sharing schema with DBAs or external tools
- Bootstrapping a fresh database without running incremental migrations

### Durable Objects migrations

For DO, drizzle-kit generates a `migrations.js` bundle that imports all `.sql` files. Apply in the thin DO constructor (see "Driver setup > Cloudflare Durable Objects" above for the full pattern):

```ts
import * as durable from 'drizzle-orm/durable-sqlite'
import * as migrator from 'drizzle-orm/durable-sqlite/migrator'
import migrations from '../drizzle/migrations.js'

// Inside DO constructor:
this.db = durable.drizzle(ctx.storage, { schema, relations: schema.relations })
ctx.blockConcurrencyWhile(async () => {
  await migrator.migrate(this.db, migrations)
})
```

The `durable-sqlite` driver is only used inside the DO for migrations. All query execution goes through the `executeSql()` RPC method and `drizzle-orm/sqlite-proxy` in the worker.

The wrangler `rules` config must import `.sql` as text for this to work:

```json
{
  "rules": [
    { "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }
  ]
}
```

## Durable Objects as a database with external access

Docs: libsqlproxy https://github.com/remorses/kimaki/tree/main/libsqlproxy | CF PITR https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api

Durable Objects with SQLite can be used as a full database, accessible from outside the worker via the libsql wire protocol (Hrana v2 HTTP). This lets you use TablePlus, DBeaver, Drizzle Studio, `@libsql/client`, or any libsql-compatible tool to query and update the DO's SQLite remotely.

### libsqlproxy

`pnpm add libsqlproxy` — read the full setup guide at https://github.com/remorses/kimaki/tree/main/libsqlproxy

**How it works:**
- Inside the DO: `createLibsqlHandler(durableObjectExecutor(ctx.storage))` bridges the Hrana v2 protocol to `ctx.storage.sql`, exposed as an RPC method (`hranaHandler`)
- In the worker: `createLibsqlProxy()` sits in front, parses the `namespace:secret` auth token from incoming requests, resolves the right DO stub via `getStub`, and forwards the Hrana request to it
- **Requires a dedicated domain/subdomain** (e.g. `libsql.example.com`) — the worker routes requests hitting that hostname to the proxy, keeping normal app traffic separate. Add it as a `custom_domain` route in `wrangler.json`

**Connecting from external tools:**

```ts
import { createClient } from '@libsql/client'

const client = createClient({
  url: 'https://libsql.example.com',
  authToken: 'my-do-id:my-shared-secret',
  //          ^^^^^^^^  ^^^^^^^^^^^^^^^^
  //          namespace  secret (validated by worker)
})

await client.execute('SELECT * FROM accounts')
```

The `authToken` format is `namespace:secret` — namespace identifies which DO to route to, secret is validated against the shared secret in the worker env. This same URL works in TablePlus, DBeaver, or drizzle-kit studio.

### Point-in-Time Recovery (PITR)

Cloudflare provides PITR for SQLite-backed Durable Objects — restore to any point in the last 30 days. No config needed, it's built in.

PITR uses **bookmarks** — lexically comparable strings representing points in time.

```ts
// Inside a DO method:

// Get current bookmark (save this before risky operations)
const bookmark = await this.ctx.storage.getCurrentBookmark()

// Get bookmark for a specific time (within last 30 days)
const twoDaysAgo = await this.ctx.storage.getBookmarkForTime(Date.now() - 2 * 24 * 60 * 60 * 1000)

// Restore to a bookmark — takes effect on next DO restart
await this.ctx.storage.onNextSessionRestoreBookmark(twoDaysAgo)
this.ctx.abort()  // restart the DO to apply the restore
```

**Expose a restore endpoint** in your DO for operational use:

```ts
async restore(timestamp: number) {
  // Save current state bookmark so we can undo if needed
  const undoBookmark = await this.ctx.storage.getCurrentBookmark()

  const bookmark = await this.ctx.storage.getBookmarkForTime(timestamp)
  // onNextSessionRestoreBookmark returns a bookmark to undo the restore
  await this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
  this.ctx.abort()  // restart DO to apply

  return { undoBookmark, restoredTo: bookmark }
}
```

PITR restores the entire SQLite database (both SQL tables and KV data). It's not available in local development (wrangler dev) because the durable change log isn't stored locally.
