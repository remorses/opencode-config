---
name: drizzle
description: >
  Drizzle ORM conventions and best practices for TypeScript projects.
  Covers namespace imports, Prisma-like query API, object-style where
  filters, schema design (ULIDs, cascade deletes, indexes, enums over bools),
  Zod schema generation, type inference, transactions, migrations, and
  driver setup for Cloudflare Durable Objects (via sqlite-proxy),
  libSQL/Turso, Postgres via Hyperdrive, and Cloudflare D1.
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

For environments where the connection depends on runtime bindings (Cloudflare D1, Hyperdrive, DO):

```ts
// Cloudflare D1 — simplest option, just pass the binding
import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import * as schema from './schema.ts'

export { schema }

export function getDb() {
  return drizzle(env.DB, { schema, relations: schema.relations })
}
```

### Cloudflare D1 with the same `import { db } from 'db'` in Workers and Node

When a project uses **D1 inside Workers** and also needs **Node.js/Bun scripts** for seeds, backfills, or admin queries, keep **one schema file** and publish **two runtime entrypoints** with the **same exports**. Do **not** put `if (process.env...)` branches in one file. Use `package.json` export conditions instead.

**Important:** in Drizzle beta, `driver: 'd1-http'` exists in **drizzle-kit config**, but there is **no public runtime import** `drizzle-orm/d1-http`. The Drizzle repo itself handles `d1-http` in `drizzle-kit/src/cli/connections.ts` by importing `drizzle-orm/sqlite-proxy` and calling the Cloudflare D1 HTTP API with `fetch()`. So the runtime pattern for Node.js/Bun scripts should be `drizzle-orm/sqlite-proxy`, not `drizzle-orm/d1-http`.

**Rule:** Wrangler/Workers should resolve a `workerd` entry that uses `drizzle-orm/d1`. Local scripts should resolve the default entry that uses `drizzle-orm/sqlite-proxy` over the Cloudflare D1 HTTP API.

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
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

export { schema }

export const db = drizzle(env.DB, {
  schema,
  relations: schema.relations,
})
```

```ts
// db/src/node.ts
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'

export { schema }

async function remoteCallback(
  sql: string,
  params: any[],
  method: 'run' | 'all' | 'values' | 'get',
) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID!}/d1/database/${process.env.CLOUDFLARE_DATABASE_ID!}/${method === 'values' ? 'raw' : 'query'}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CLOUDFLARE_D1_TOKEN!}`,
      },
      body: JSON.stringify({ sql, params }),
    },
  )

  const data = await response.json() as {
    success: boolean
    errors?: { code: number; message: string }[]
    result: Array<{ results: any[] | { rows: any[] } }>
  }

  if (!data.success) {
    throw new Error(data.errors?.map((error) => `${error.code}: ${error.message}`).join('\n') ?? 'Unknown D1 error')
  }

  const result = data.result[0]?.results
  const rows = Array.isArray(result) ? result : (result?.rows ?? [])

  // sqlite-proxy expects a falsy rows value for `get` no-row results.
  // Returning [] is truthy and can produce `{ id: undefined }` in findFirst.
  // https://github.com/drizzle-team/drizzle-orm/issues/5461
  return { rows: method === 'get' && rows.length === 0 ? undefined : rows }
}

export const db = drizzle(remoteCallback, { schema, relations: schema.relations })
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

This pattern is the simplest way to keep **one Drizzle schema**, **one import path**, and still run **scripts outside Cloudflare**.

```ts
// Cloudflare Hyperdrive (Postgres)
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

**Latency rule:** prefer `db.query` because it emits **exactly one SQL statement**, even when using `with` and relation filters. This is especially important on high-latency databases like D1 and serverless Postgres, where extra round-trips dominate response time. If you can express the read with relations, `db.query` is usually the best choice.

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
- `db.query` with `with` still runs as **one SQL query**, not N queries. Prefer it for latency-sensitive reads.
- Use `orderBy` as object: `{ createdAt: 'desc' }`
- Use `findFirst` (adds `LIMIT 1`) or `findMany`
- **NEVER use `orm.inArray()`, `orm.eq()`, or other operator functions inside `db.query` `where`** — the query API only accepts object-style filters. `orm.inArray(schema.users.id, ids)` will fail with a type error. Instead, use `{ id: { in: ids } }` or loop with `findFirst` per ID.

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

Always prefer generating Zod schemas from your Drizzle tables instead of duplicating the same fields by hand in API code. This keeps validation, OpenAPI output, and DB schema in sync.

If the repo uses Drizzle v1 beta (`drizzle-orm@1.0.0-beta.x`), import from `drizzle-orm/zod` directly. Only use `drizzle-zod` on older Drizzle versions.

```ts
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/zod'

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

Prefer composition over duplication:

```ts
const projectSummarySchema = createSelectSchema(schema.project).pick({
  id: true,
  orgId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
})

const projectCreateSchema = createInsertSchema(schema.project).pick({
  name: true,
  orgId: true,
})

const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
})
```

Rules:

- Prefer `createSelectSchema(table).pick(...)` for response items derived from a table
- Prefer `createInsertSchema(table).pick(...)` / `createUpdateSchema(table).pick(...)` for request bodies
- Only hand-write Zod objects for envelopes, computed fields, or shapes that do not map 1:1 to a table row
- If an API shape mostly mirrors a table, derive it from the table first and then `.extend()` with the extra fields

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

Postgres: `pgCore.timestamp('created_at').defaultNow().notNull()`.

SQLite with D1: use a `customType` called `epochMs` instead of `integer({ mode: 'number' })`. This is required because BetterAuth passes `Date` objects as bind parameters, but D1 only accepts `string | number | null | ArrayBuffer`. The `epochMs` type converts `Date → date.getTime()` via drizzle's `toDriver` hook while keeping the TypeScript type as `number`.

```ts
import * as sqliteCore from 'drizzle-orm/sqlite-core'

// Integer column that stores epoch milliseconds as a plain number.
// Unlike integer({ mode: 'number' }), this accepts Date objects in toDriver
// so BetterAuth's internal Date params don't crash D1's .bind().
export const epochMs = sqliteCore.customType<{ data: number; driverParam: number }>({
  dataType() { return 'integer' },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    return value as number
  },
  fromDriver(value: unknown): number { return value as number },
})

// Usage:
const user = sqliteCore.sqliteTable('user', {
  id: sqliteCore.text('id').primaryKey(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})
```

Why not `integer({ mode: 'timestamp_ms' })`? That changes the TypeScript type from `number` to `Date`, breaking all code that does arithmetic on timestamps, and JSON serialization changes from epoch numbers to ISO strings (breaking CLI/API clients).

Why not the `supportsDates: false` adapter flag? BetterAuth converts `Date → toISOString()` (a string), which would store text in integer columns, corrupting data.

The `epochMs` approach generates the same `integer` SQL type, so no migration is needed when switching from `integer({ mode: 'number' })`.

SQLite without D1 (e.g. better-sqlite3, libsql): plain `integer({ mode: 'number' })` works if BetterAuth is not in the picture. Use `epochMs` whenever BetterAuth + SQLite are combined.

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

Docs: D1 https://orm.drizzle.team/docs/connect-cloudflare-d1 | Durable Objects https://orm.drizzle.team/docs/connect-cloudflare-do | Turso https://orm.drizzle.team/docs/connect-turso | All drivers https://orm.drizzle.team/docs/connect-overview

### Cloudflare D1 (recommended for Cloudflare SQLite)

D1 is Cloudflare's managed SQLite database. It's the simplest option for Cloudflare Workers — no Durable Objects, no proxy layers, just pass the D1 binding directly to drizzle.

**Prefer D1 over Durable Objects** for new projects unless you specifically need DO features (like single-point-of-serialization, WebSocket hibernation, or PITR). D1 is simpler to set up, has native `db.batch()` support, and uses `wrangler d1 migrations apply` for schema management.

**Driver setup:**

```ts
// src/db.ts
import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

export function getDb() {
  return drizzle(env.DB, { schema, relations: schema.relations })
}
```

That's it — `drizzle(env.DB)` with schema and relations. No stub, no RPC, no proxy.

**drizzle.config.ts:**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: './src/schema.ts',
  dialect: 'sqlite',
  // No `driver` field for D1 — just dialect: 'sqlite'
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
      "migrations_dir": "./drizzle"
    }
  ]
}
```

**Creating D1 databases:**

```bash
wrangler d1 create my-app-db
wrangler d1 create my-app-preview-db
```

**D1 migrations with wrangler:**

Drizzle-kit generates migrations as subdirectories (`<timestamp>_<name>/migration.sql`), but **wrangler D1 only recognizes flat `.sql` files** in `migrations_dir`. It does not search subdirectories. This is a known incompatibility (drizzle-team/drizzle-orm#5266, cloudflare/workers-sdk#13257). Migrations stuck in subdirectories are silently ignored by wrangler and never applied.

**Best practice: automate flattening with a post-generate script.** Add a TypeScript script that scans the migrations directory after `drizzle-kit generate`, finds subdirectories with no flat counterpart, and copies them out with sequential numbering (`0001_`, `0002_`, ...). Chain it in your generate script so it runs automatically:

```json
{
  "scripts": {
    "generate": "drizzle-kit generate && tsx scripts/flatten-migrations.ts ./drizzle",
    "flatten": "tsx scripts/flatten-migrations.ts ./drizzle"
  }
}
```

Copy the flatten script from `scripts/flatten-migrations.ts` bundled with this skill into your project's scripts directory. It scans for subdirectories containing `migration.sql`, skips any that already have a flat counterpart (matched by content), and copies new ones as `NNNN_<slug>.sql` with sequential numbering. Subdirectories are kept intact for drizzle-kit's snapshot tracking.

**Applying migrations:**

```bash
# Apply to remote D1 database
wrangler d1 migrations apply DB --remote

# Apply to preview environment
wrangler d1 migrations apply DB --remote --env preview

# Apply locally for dev
wrangler d1 migrations apply DB --local
```

Always migrate **before** deploying the new worker code that depends on the schema change.

**Running scripts against D1 outside Workers (seeds, backfills, one-off queries):**

Use `drizzle-orm/sqlite-proxy` to talk to remote D1 databases from any Node.js/Bun script. No Worker runtime required. Each query is an HTTP round-trip to Cloudflare's API, so it's slower than in-worker queries but works anywhere.

Do **not** write `import { drizzle } from 'drizzle-orm/d1-http'` in runtime code. In Drizzle beta, that path is **not** a public `drizzle-orm` export. `d1-http` is a **drizzle-kit driver name**, not a runtime import path. The Drizzle repo currently wires it up in `drizzle-kit/src/cli/connections.ts` via `drizzle-orm/sqlite-proxy` plus `fetch()`.

**Required environment variables:**

- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID
- `CLOUDFLARE_DATABASE_ID` — the D1 database UUID
- `CLOUDFLARE_D1_TOKEN` — Cloudflare API token with at least `Account - D1 - Edit`

If the tool also needs to discover account metadata, add `Account - Account Settings - Read` to the token too.

```ts
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'

const db = drizzle(
  async (sql, params, method) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID!}/d1/database/${process.env.CLOUDFLARE_DATABASE_ID!}/${method === 'values' ? 'raw' : 'query'}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.CLOUDFLARE_D1_TOKEN!}`,
        },
        body: JSON.stringify({ sql, params }),
      },
    )

    const data = await response.json() as {
      success: boolean
      errors?: { code: number; message: string }[]
      result: Array<{ results: any[] | { rows: any[] } }>
    }

    if (!data.success) {
      throw new Error(data.errors?.map((error) => `${error.code}: ${error.message}`).join('\n') ?? 'Unknown D1 error')
    }

    const result = data.result[0]?.results
    const rows = Array.isArray(result) ? result : (result?.rows ?? [])

    // sqlite-proxy expects a falsy rows value for `get` no-row results.
    // Returning [] is truthy and can produce `{ id: undefined }` in findFirst.
    // https://github.com/drizzle-team/drizzle-orm/issues/5461
    return { rows: method === 'get' && rows.length === 0 ? undefined : rows }
  },
  { schema, relations: schema.relations },
)

// Full drizzle ORM, same API as inside the worker
const users = await db.query.users.findMany()
await db.insert(schema.users).values({ name: 'Seed User', email: 'seed@example.com' })
```

The `token` is a Cloudflare API token with **D1:Edit** permission, created at https://dash.cloudflare.com/profile/api-tokens. The `databaseId` is the UUID from `wrangler d1 list` or your `wrangler.jsonc`.

```bash
# plain shell env injection
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

This is why the conditional-exports pattern above matters. The script imports the **same `db` symbol** as Worker code, but Node resolves `drizzle-orm/sqlite-proxy` while Wrangler resolves `drizzle-orm/d1`.

The same env vars also work well for `drizzle-kit studio`, `drizzle-kit pull`, or any other local admin script that talks to the remote D1 database.

For local scripts against local D1, use `wrangler d1 execute DB --local --command "..."` or connect directly to the SQLite file at `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` via `better-sqlite3`.

**Batch support** — D1 natively supports `db.batch()`. No extra setup needed:

```ts
const db = getDb()
const [users, posts] = await db.batch([
  db.query.users.findMany(),
  db.query.posts.findMany({ where: { status: 'published' } }),
])
```

**Migrating from Durable Objects to D1:**

If you're switching an existing worker from DO to D1:
1. Create D1 databases with `wrangler d1 create`
2. Replace `drizzle-orm/sqlite-proxy` with `drizzle-orm/d1` in your `db.ts`
3. Replace `durable_objects` bindings with `d1_databases` in `wrangler.jsonc`
4. Add `deleted_classes` migration tag to remove old DO classes:
   ```jsonc
   "migrations": [
     { "tag": "v1", "new_sqlite_classes": ["OldStore"] },
     { "tag": "v2", "deleted_classes": ["OldStore"] }
   ]
   ```
5. Delete the DO class file, remove its export from `app.tsx`
6. Remove `driver: 'durable-sqlite'` from drizzle.config.ts
7. Remove `rules` for `.sql` text imports (no longer needed)
8. Regenerate types with `wrangler types`

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

  // Shared logic for executing a single SQL statement and formatting the
  // result for drizzle-orm/sqlite-proxy's expected { rows } shape.
  private execOne(sql: string, params: unknown[], method: string) {
    const stmt = this.ctx.storage.sql.exec(sql, ...params)
    const columnNames = stmt.columnNames
    const rawRows = stmt.toArray()

    if (method === 'get') {
      const row = rawRows[0]
      // MUST return { rows: null } (falsy) when no row found.
      // Returning { rows: [] } breaks rqb v2 (findFirst) because [] is truthy,
      // causing drizzle to call JSON.parse([]) → SyntaxError.
      // Use null instead of undefined because undefined gets dropped by
      // Cloudflare RPC structured clone serialization.
      if (!row) return { rows: null }
      return { rows: columnNames.map((col) => (row as Record<string, unknown>)[col]) }
    }

    const rows = rawRows.map((row) =>
      columnNames.map((col) => (row as Record<string, unknown>)[col]),
    )
    return { rows }
  }

  // RPC: execute a single SQL query. Called by sqlite-proxy's execute callback.
  async executeSql(sql: string, params: unknown[], method: string) {
    return this.execOne(sql, params, method)
  }

  // RPC: execute multiple SQL statements in a single RPC round-trip.
  // Called by sqlite-proxy's batchCallback. All statements run sequentially
  // in the DO's local SQLite — one RPC instead of N worker↔DO round-trips.
  async executeSqlBatch(batch: { sql: string; params: unknown[]; method: string }[]) {
    return batch.map((q) => this.execOne(q.sql, q.params, q.method))
  }
}
```

**Step 2 — Worker-level drizzle client via sqlite-proxy (with batch support):**

The `drizzle()` function from `sqlite-proxy` accepts an optional second callback for batch operations. Without it, `db.batch()` will throw at runtime even though the type exists.

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
  return drizzle(
    // Execute callback — one query per RPC call
    async (sql, params, method) => {
      return stub.executeSql(sql, params, method) as any
    },
    // Batch callback — N queries in one RPC call
    async (batch) => {
      return stub.executeSqlBatch(batch) as any
    },
    { schema, relations: schema.relations },
  )
}
```

The `drizzle()` overload signature is:
```ts
drizzle(callback: RemoteCallback, batchCallback: AsyncBatchRemoteCallback, config?: DrizzleConfig)
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

### Prefer no transaction at all

**Transactions are the first thing that breaks under load.** They hold locks, hog connections, and cause contention. Before reaching for any transaction or batch, ask yourself: do I actually need atomicity here? Most writes are idempotent or can be retried independently. If a partial failure is acceptable (e.g. an export that can be re-run), just use plain sequential or parallel queries with no transaction wrapper.

Only use `db.batch()` when you genuinely need atomicity (all-or-nothing). Never use `db.transaction()` (interactive transactions) at all.

### If you need atomicity, use `db.batch()`, NEVER `db.transaction()`

**Never use `db.transaction()`.** It holds an open database transaction across multiple round-trips, one per statement. This causes serious problems in production:
- Transactions last too long (each statement waits for a network round-trip before the next one starts)
- They hog database connections and locks, starving other requests
- They fail frequently even at low RPS because of lock contention and timeouts
- On serverless/edge (Cloudflare Workers, Vercel), cold starts make it even worse

**Use `db.batch()` instead** when atomicity is required. It sends all statements in a single HTTP request. The database wraps them in an implicit transaction (BEGIN → statements → COMMIT). If any statement fails, the whole batch rolls back. Same atomicity guarantees, zero round-trip overhead.

```ts
const [newUsers, updatedPosts, allComments] = await db.batch([
  db.insert(users).values({ name: 'Alice' }).returning(),
  db.update(posts).set({ status: 'published' }).where(orm.eq(posts.id, 1)),
  db.query.comments.findMany(),
])
```

Statements execute **in order** inside one transaction, so statement 2 sees data that statement 1 inserted. The only limitation is you can't use the **return value** of statement 1 to build statement 2 in your TS code (all queries are defined upfront as an array). If you truly need to chain return values, do two separate batch calls, still better than holding a transaction open.

### Never pass unbounded arrays to `db.batch()`

**Always cap the size of arrays passed to `db.batch()`.** An unbounded array (e.g. all rows from user input or a full table scan) inside a single batch creates a massive transaction that locks the database for the entire duration. Large projects with thousands of rows will hit timeouts and starve other requests.

If you have a dynamic array of unknown size, split it into fixed-size chunks and batch each chunk separately. Or better yet, if atomicity is not needed, just use plain inserts without batching at all.

### Batch patterns

**Parent + child inserts** — pre-generate the ULID so both inserts can go in one batch:

```ts
import { ulid } from 'ulid'

const orgId = ulid()
const [[org]] = await db.batch([
  db.insert(schema.org).values({ id: orgId, name: 'Acme' })
    .returning({ id: schema.org.id, name: schema.org.name }),
  db.insert(schema.orgMember).values({ orgId, userId, role: 'admin' }),
] as const)
```

This works because IDs use `$defaultFn(() => ulid())` — generated client-side, so we can pre-generate and share across inserts.

**Parent + multiple children:**

```ts
const projectId = ulid()
const [[proj]] = await db.batch([
  db.insert(schema.project).values({ id: projectId, name, orgId })
    .returning({ id: schema.project.id, name: schema.project.name }),
  ...DEFAULT_ENVIRONMENTS.map((e) =>
    db.insert(schema.environment).values({ projectId, name: e.name, slug: e.slug }),
  ),
] as const)
```

**Bulk writes after async prep** — encrypt/compute first, then batch all inserts:

```ts
const entries = Object.entries(secrets)
const encrypted = await Promise.all(entries.map(([, value]) => encrypt(value)))
await db.batch(
  entries.map(([name], i) =>
    db.insert(schema.secretEvent).values({
      environmentId, name,
      operation: 'set',
      valueEncrypted: encrypted[i]!.encrypted,
      iv: encrypted[i]!.iv,
    }),
  ) as [any, ...any[]],
)
```

**Multiple reads in parallel:**

```ts
const results = await db.batch(
  environmentIds.map((envId) =>
    db.query.secretEvent.findMany({
      where: { environmentId: envId },
      orderBy: { createdAt: 'asc' },
    }),
  ) as [any, ...any[]],
)
```

### TypeScript tuple constraint

`db.batch()` requires `Readonly<[U, ...U[]]>` — a non-empty tuple. `.map()` returns `T[]` which TypeScript can't narrow to a non-empty tuple, even after a `.length > 0` check. The standard workaround is a cast:

```ts
// Static arrays — use `as const`
await db.batch([query1, query2] as const)

// Dynamic arrays from .map() — cast to tuple
await db.batch(items.map(makeQuery) as [any, ...any[]])

// Or with typed items
import type { BatchItem } from 'drizzle-orm/batch'
const queries: BatchItem<'sqlite'>[] = []
// ... push queries ...
if (queries.length > 0) {
  await db.batch(queries as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
}
```

This is a known drizzle limitation (drizzle-team/drizzle-orm#1292). The cast is safe because we guard with a length check at runtime.

## Foreign key ordering in parallel writes

**Always read the schema before writing insert/update code.** Trace the foreign key dependency chain and make sure parent rows exist before inserting child rows. This applies to `Promise.all`, `db.batch()`, and any concurrent write pattern.

When running multiple inserts in parallel (e.g. `Promise.all` or `db.batch()`), child tables that reference parent tables via foreign keys **must wait** for the parent inserts to complete first. Running them all in a single parallel step causes intermittent FK constraint violations in production.

### How to think about it

1. Read the schema and draw the FK dependency chain
2. Group tables into layers: tables with no FK dependencies go in layer 1, tables that reference layer 1 go in layer 2, etc.
3. Execute each layer sequentially; within a layer, inserts can run in parallel

### Example: wrong vs right

Given these tables where `Breakpoint` → `Component` and `Instance` → `Component` + `WebPage`:

```ts
// BAD: all inserts in one Promise.all — Breakpoint may insert before Component exists
await Promise.all([
  db.insert(component).values(components),
  db.insert(webPage).values(pages),
  db.insert(breakpoint).values(breakpoints),    // FK → component
  db.insert(instance).values(instances),         // FK → component + webPage
])

// GOOD: parent tables first (layer 1), then dependent tables (layer 2)
await Promise.all([
  db.insert(component).values(components),       // layer 1
  db.insert(webPage).values(pages),              // layer 1
])
await Promise.all([
  db.insert(breakpoint).values(breakpoints),     // layer 2: FK → component
  db.insert(instance).values(instances),         // layer 2: FK → component + webPage
])
```

With `db.batch()` this is handled automatically because statements execute in order inside one transaction. But with `Promise.all` or any other concurrent pattern, you must manually respect the dependency chain.

This also applies to **deletes in reverse order**: delete children first, then parents. Otherwise you get FK violations on the delete side too (unless `onDelete: Cascade` handles it).

## Migrations & SQL export

Docs: Overview https://orm.drizzle.team/docs/kit-overview | Generate https://orm.drizzle.team/docs/drizzle-kit-generate | Migrate https://orm.drizzle.team/docs/drizzle-kit-migrate | Push https://orm.drizzle.team/docs/drizzle-kit-push | Export https://orm.drizzle.team/docs/drizzle-kit-export | Config https://orm.drizzle.team/docs/drizzle-config-file

### Generate migration files

```bash
pnpm drizzle-kit generate
```

Creates numbered `.sql` files in the `out` directory (e.g. `./drizzle/0000_dear_lord_tyger.sql`).

### Non-interactive `drizzle-kit generate` (CI / agents)

`drizzle-kit generate` prompts interactively when it detects a table/column rename vs. create+drop ambiguity (e.g. "Is `secret_event` created or renamed from `secret`?"). This fails in non-TTY environments (CI, piped shells, coding agents) with:

```
Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false)
```

**There is no official `--non-interactive` or `--auto-approve` flag yet** (tracked in drizzle-team/drizzle-orm#5307 and #4941). Workarounds:

1. **Write migration SQL manually** — for simple changes (drop table + create table), write the `.sql` file and update `migrations.js` yourself. This is the most reliable approach for agents:

```bash
# Create the migration directory with a timestamp-based name
mkdir -p drizzle/20260415130000_my_migration

# Write the SQL file
cat > drizzle/20260415130000_my_migration/migration.sql << 'SQL'
DROP TABLE `old_table`;
--> statement-breakpoint
CREATE TABLE `new_table` ( ... );
SQL

# Add the import to migrations.js
# (append the new import + entry to the migrations object)
```

2. **Use `expect` or `script`** — wrap drizzle-kit in a TTY simulator to auto-answer prompts. Fragile and not recommended.

3. **Use `--name` to name migrations** — doesn't skip prompts but helps identify them:

```bash
pnpm drizzle-kit generate --name=event-sourced-secrets
```

When writing migrations manually for Durable Objects, remember to also update `migrations.js` with the new import entry so `migrator.migrate()` picks it up at runtime. The snapshot.json is only needed by drizzle-kit for computing future diffs — the migration will run fine without it, and the next interactive `drizzle-kit generate` will regenerate a fresh snapshot.

### Apply migrations

```bash
# Apply to database (Postgres, libSQL)
doppler run -- pnpm drizzle-kit migrate

# Apply to Cloudflare D1 (use wrangler, not drizzle-kit)
wrangler d1 migrations apply DB --remote              # production
wrangler d1 migrations apply DB --remote --env preview # preview
wrangler d1 migrations apply DB --local                # local dev

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
- **Usually wants a dedicated domain/subdomain** (e.g. `libsql.example.com`) so external tools have a stable hostname and the proxy stays separate from normal app traffic. But this is for the proxy endpoint itself — do **not** add wrangler `routes` / `custom_domain` rules just because the project uses Spiceflow or Vite. Add a `custom_domain` route only if you actually want that hostname.

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
