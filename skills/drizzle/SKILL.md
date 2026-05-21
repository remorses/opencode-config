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

`SKILL.md` is the entrypoint. Read this first.

If the project is **deployed on Cloudflare** or uses **D1**, **Hyperdrive**, **Durable Objects**, `wrangler`, or `cloudflare:workers`, you MUST also read the companion doc `./cloudflare.md` before writing code. That file contains the Cloudflare-only runtime, driver, and migration rules.

## CRITICAL: Always use drizzle beta, NEVER v0

Always install `drizzle-orm@beta` and `drizzle-kit@beta` (currently 1.0.0-beta.x). NEVER use `drizzle-orm@latest` which resolves to v0.x — it lacks `defineRelations`, 2-param `DrizzleSqliteDODatabase`, and other v1 features used throughout this skill.

```bash
pnpm install drizzle-orm@beta
pnpm install drizzle-kit@beta --save-dev
```

**Docs reference:** https://orm.drizzle.team/llms.txt — full docs index for LLMs. Fetch this when you need to look up something not covered here.

## CRITICAL: Duplicate drizzle-orm in pnpm monorepos

In pnpm monorepos, `drizzle-orm` can get installed as two separate copies when different packages in the workspace resolve it with different peer dependency sets (e.g. one with `@cloudflare/workers-types`, one without). TypeScript sees them as incompatible types because drizzle-orm uses private class fields internally.

**Symptoms:** `Types have separate declarations of a private property 'cachedTables'`, `db.query.tableName is possibly undefined`, `orm.eq()` not assignable to parameter, where clauses rejected with type errors. These errors appear on `db.insert()`, `db.update()`, `db.delete()`, `db.query`, and `orm.eq/and/or` calls when the schema is imported from a different workspace package than the one calling drizzle.

**Diagnosis:** search for duplicates in the lockfile:

```bash
grep " drizzle-orm@" pnpm-lock.yaml
```

If you see multiple entries with different peer dep suffixes in parentheses, you have duplicates.

**Fix:** run `pnpm dedupe drizzle-orm` from the workspace root. This collapses the duplicate entries into one. If that doesn't work, load the `pnpm` skill for the full deduplication workflow.

Never work around this with type casts (`as any`, `as unknown as T`, `!`). The casts hide the real problem and break silently when drizzle internals change.

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

For runtime-bound environments like Cloudflare, read `./cloudflare.md`. It covers D1, Durable Objects, Hyperdrive, export conditions, D1 HTTP access from Node, and Cloudflare-specific migration rules.

## Namespace imports

Always use namespace imports to avoid polluting local scope with generic names like `eq`, `and`, `gt`, `text`, `integer`:

```ts
import * as orm from 'drizzle-orm'
import * as s from 'drizzle-orm/sqlite-core'
import * as p from 'drizzle-orm/pg-core'
```

**Use short single-letter aliases for dialect modules in schema files.** Schema files are dominated by column/table/index definitions; you write `s.text`, `s.integer`, `s.sqliteTable`, `s.index` dozens of times per file. The shorter prefix keeps the schema scannable and lets the actual column definitions stand out instead of the namespace:

```ts
export const user = s.sqliteTable('user', {
  id: s.text('id').primaryKey(),
  name: s.text('name').notNull(),
  role: s.text('role', { enum: ['admin', 'member'] }).notNull(),
  createdAt: s.integer('created_at', { mode: 'number' }).notNull(),
})
```

Same for Postgres: `p.pgTable`, `p.text`, `p.pgEnum`, `p.index`.

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
const users = s.sqliteTable('users', {
  id: s.text('id').primaryKey().$defaultFn(() => ulid()),
  name: s.text('name').notNull(),
})

const orgs = s.sqliteTable('orgs', {
  id: s.text('id').primaryKey().$defaultFn(() => ulid()),
  name: s.text('name').notNull(),
})

// Junction table — cascade both sides so deleting a user or org cleans up memberships
const orgUsers = s.sqliteTable('org_users', {
  id: s.text('id').primaryKey().$defaultFn(() => ulid()),
  userId: s.text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: s.text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  role: s.text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  createdAt: s.integer('created_at', { mode: 'number' }).notNull(),
}, (table) => [
  s.index('org_users_user_id_idx').on(table.userId),
  s.index('org_users_org_id_idx').on(table.orgId),
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
- Always **inline `where` objects** directly in `db.query.*` calls. Do not extract them into reusable constants. Inline objects give better property autocomplete and clearer TypeScript errors at the call site.
- Use `AND`, `OR`, `NOT` for logical combinations
- Use `with` to include relations (like Prisma's `include`)
- `db.query` with `with` still runs as **one SQL query**, not N queries. Prefer it for latency-sensitive reads.
- Use `orderBy` as object: `{ createdAt: 'desc' }`
- Use `findFirst` (adds `LIMIT 1`) or `findMany`
- **NEVER use `orm.inArray()`, `orm.eq()`, or other operator functions inside `db.query` `where`** — the query API only accepts object-style filters. `orm.inArray(schema.users.id, ids)` will fail with a type error. Instead, use `{ id: { in: ids } }` or loop with `findFirst` per ID.
- **Do not use `columns` to select specific fields.** Listing every column you want adds noise, rarely helps performance on small rows, and makes the returned object not conform to drizzle Zod schemas (`createSelectSchema`). The only valid use is **omitting** a large field like a binary blob or long text body, and in that case use the exclusion form: `columns: { blobField: false }`. This keeps the query clean and returns everything except the excluded field.

**Writes: use `db.insert`, `db.update`, `db.delete`** — no query API for writes.

```ts
// For write .where() clauses, use orm.eq since there is no object-style where for writes
await db.update(schema.accounts)
  .set({ accessToken: newToken, updatedAt: Date.now() })
  .where(orm.eq(schema.accounts.id, accountId))
  .limit(1)
```

## CRITICAL: Safe updates and deletes

**Every `db.update()` and `db.delete()` MUST have a `.where()` clause.** Never call `.update().set(...)` or `.delete()` without `.where()`. A missing where silently affects every row in the table. There is no drizzle config to enforce this at runtime; it is a discipline rule.

**Every single-row update/delete MUST have `.limit(1)`.** This caps the SQL statement at the database level so even if the where clause is wrong (e.g. a field resolved to `undefined` and matched unexpectedly), at most 1 row is affected. Only skip `.limit(1)` when you are intentionally updating or deleting multiple rows (bulk status change, batch cleanup, etc.).

```ts
// Single-row update — always .where() + .limit(1)
await db.update(schema.users)
  .set({ name: 'New Name' })
  .where(orm.eq(schema.users.id, userId))
  .limit(1)

// Single-row delete — always .where() + .limit(1)
await db.delete(schema.sessions)
  .where(orm.eq(schema.sessions.id, sessionId))
  .limit(1)

// Bulk update — .where() required, .limit(1) intentionally omitted
await db.update(schema.notifications)
  .set({ read: true })
  .where(orm.eq(schema.notifications.userId, userId))
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
  .limit(1)

// Update with returning (get back the updated row)
const [updated] = await db.update(schema.accounts)
  .set({ status: 'archived' })
  .where(orm.eq(schema.accounts.id, accountId))
  .limit(1)
  .returning()
```

**IMPORTANT: Never include primary keys in UPDATE SET clauses on SQLite/D1.** When SQLite sees `UPDATE user SET id = ?, name = ? WHERE id = ?`, it checks all foreign key constraints referencing that `id`, even if the value isn't changing. If the user has 1000 sessions, that's 1000+ extra row reads billed by D1. Always use explicit field lists in `.set({})` and never pass the full object. This applies to any ORM layer on SQLite, not just Drizzle.

```ts
// BAD — passes id in SET, triggers FK constraint checks on every referencing row
await db.update(schema.users).set(userParam).where(orm.eq(schema.users.id, userParam.id))

// GOOD — explicit fields, no id in SET
await db.update(schema.users)
  .set({ name: userParam.name, updatedAt: Date.now() })
  .where(orm.eq(schema.users.id, userParam.id))
  .limit(1)
```

### Delete

```ts
// Delete by condition
await db.delete(schema.boards)
  .where(orm.eq(schema.boards.id, boardId))
  .limit(1)

// Delete with returning (get back the deleted row)
const [deleted] = await db.delete(schema.boards)
  .where(orm.eq(schema.boards.id, boardId))
  .limit(1)
  .returning()
```

With `onDelete: 'cascade'` on foreign keys, deleting a parent automatically deletes all children:

```ts
// Deleting an account cascades to all its boards
await db.delete(schema.accounts)
  .where(orm.eq(schema.accounts.id, accountId))
  .limit(1)
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

### Enum union types

For SQLite text enums, define the allowed values in the column config and derive the union type from `$inferSelect` or `$inferInsert`. Do not duplicate a separate TypeScript union next to the schema.

```ts
export const botTokens = s.sqliteTable('bot_tokens', {
  botMode: s
    .text('bot_mode', { enum: ['self_hosted', 'gateway'] })
    .notNull()
    .default('self_hosted'),
})

export type BotMode = typeof botTokens.$inferSelect.botMode
// "self_hosted" | "gateway"
```

Use the same pattern for status and preference columns:

```ts
export type VerbosityLevel = typeof channelVerbosity.$inferSelect.verbosity
export type WorktreeStatus = typeof threadWorktrees.$inferSelect.status
export type ThreadSessionSource = typeof threadSessions.$inferSelect.source
```

SQLite does not enforce these enum values at runtime. `text({ enum: [...] })` only affects TypeScript insert/select inference. Add a `CHECK` constraint manually only when database-level enforcement is actually needed.

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

const projects = s.sqliteTable('projects', {
  projectId: s.text('project_id').primaryKey().notNull().$defaultFn(() => ulid()),
  // ...
})
```

For Postgres:

```ts
const projects = p.pgTable('projects', {
  projectId: p.text('project_id').primaryKey().notNull().$defaultFn(() => ulid()),
  // ...
})
```

### Table-specific ID columns

**Always name primary key columns after the table**, not just `id`. For example, the `projects` table uses `projectId`, the `accounts` table uses `accountId`, the `environments` table uses `environmentId`.

This makes joins, filters, and relations self-documenting. When you see `projectId` in a child table, you immediately know which table it references. The FK column name matches the referenced PK column name, so you never have to mentally map between different names.

```ts
const projects = s.sqliteTable('projects', {
  projectId: s.text('project_id').primaryKey().$defaultFn(() => ulid()),
  name: s.text('name').notNull(),
})

const environments = s.sqliteTable('environments', {
  environmentId: s.text('environment_id').primaryKey().$defaultFn(() => ulid()),
  projectId: s.text('project_id').notNull().references(() => projects.projectId, { onDelete: 'cascade' }),
})

// filters use the same name as the referenced PK, shorthand works naturally
await db.query.environments.findMany({ where: { projectId } })

// relations use the same name on both sides
export const relations = defineRelations({ projects, environments }, (r) => ({
  projects: {
    environments: r.many.environments(),
  },
  environments: {
    project: r.one.projects({
      from: r.environments.projectId,
      to: r.projects.projectId,
    }),
  },
}))

// writes are also consistent
await db.update(schema.projects)
  .set({ name: 'New Name' })
  .where(orm.eq(schema.projects.projectId, projectId))
  .limit(1)
```

### Foreign keys with cascade delete

Always set `onDelete: 'cascade'` on child references so deleting a parent cleans up children:

```ts
accountId: s.text('account_id')
  .notNull()
  .references(() => accounts.accountId, { onDelete: 'cascade' }),
```

### `.references()` vs `defineRelations()` — use both

These are two separate layers that serve different purposes:

| | `.references()` | `defineRelations()` |
|---|---|---|
| **What it does** | Generates a `FOREIGN KEY` constraint in the DDL migration SQL | Tells drizzle's query builder how to JOIN tables |
| **Enforced by** | The database engine | Application code (drizzle) |
| **Generates DDL** | Yes (`REFERENCES org(id) ON DELETE CASCADE`) | No |
| **Enables `db.query` `with`** | No | Yes |
| **Cascade deletes** | Yes, at DB level | No |
| **Catches orphaned rows** | Yes, rejects invalid inserts | No |

**Always use both.** `.references()` enforces data integrity at the database level; `defineRelations()` enables drizzle's relational query API (`db.query` with `with: { ... }`). Dropping `.references()` means the DB won't reject orphaned foreign keys. Dropping `defineRelations()` means `db.query` won't know how to join.

You *can* have `defineRelations` without `.references()` (some databases like PlanetScale MySQL don't support FK constraints), but for SQLite/D1 and Postgres, always add both.

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
      to: r.accounts.accountId,
    }),
  },
}))
```

### Index every FK column

Drizzle does not auto-index foreign keys. Add explicit indexes:

```ts
const boards = s.sqliteTable('boards', {
  boardId: s.text('board_id').primaryKey().notNull().$defaultFn(() => ulid()),
  accountId: s.text('account_id')
    .notNull()
    .references(() => accounts.accountId, { onDelete: 'cascade' }),
  // ...
}, (table) => [
  s.index('boards_account_id_idx').on(table.accountId),
])
```

### Enums over booleans

Booleans are not extensible. Use enums:

```ts
// BAD
isActive: s.integer('is_active', { mode: 'boolean' }),
isArchived: s.integer('is_archived', { mode: 'boolean' }),

// GOOD — one column, extensible, self-documenting
status: s.text('status', { enum: ['active', 'archived', 'suspended'] }).notNull().default('active'),
```

For Postgres use `pgEnum`:

```ts
const statusEnum = p.pgEnum('status', ['active', 'archived', 'suspended'])

const accounts = p.pgTable('accounts', {
  status: statusEnum('status').notNull().default('active'),
})
```

### Tables over JSON blobs

Never store structured domain data as `JSON.stringify()` in a text column. Create proper relational tables instead — you get type safety, indexes, foreign keys, query filtering.

```ts
// BAD — loses all type safety, can't query/index/constrain
trackedRepos: s.text('tracked_repos').notNull().default('[]'),
// usage: JSON.parse(row.trackedRepos) as string[]  // unsafe cast

// GOOD — proper table with foreign key, indexable, type-safe
const trackedRepos = s.sqliteTable('tracked_repos', {
  id: s.text('id').primaryKey().$defaultFn(() => ulid()),
  boardId: s.text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  repoUrl: s.text('repo_url').notNull(),
}, (table) => [
  s.index('tracked_repos_board_id_idx').on(table.boardId),
])
```

Exception: truly unstructured/opaque data (raw API responses for debugging) can be JSON. But never domain data you query or filter on.

### Timestamps

Postgres: `p.timestamp('created_at').defaultNow().notNull()`.

SQLite with D1: use a `customType` called `epochMs` instead of `integer({ mode: 'number' })`. This is required because BetterAuth passes `Date` objects as bind parameters, but D1 only accepts `string | number | null | ArrayBuffer`. The `epochMs` type converts `Date → date.getTime()` via drizzle's `toDriver` hook while keeping the TypeScript type as `number`.

```ts
import * as s from 'drizzle-orm/sqlite-core'

// Integer column that stores epoch milliseconds as a plain number.
// Unlike integer({ mode: 'number' }), this accepts Date objects in toDriver
// so BetterAuth's internal Date params don't crash D1's .bind().
export const epochMs = s.customType<{ data: number; driverParam: number }>({
  dataType() { return 'integer' },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    return value as number
  },
  fromDriver(value: unknown): number { return value as number },
})

// Usage:
const user = s.sqliteTable('user', {
  id: s.text('id').primaryKey(),
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

### Cloudflare (D1, Durable Objects, Hyperdrive)

Read the companion doc `./cloudflare.md` for all Cloudflare connection patterns and binding-based setup.

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

Docs: Turso https://orm.drizzle.team/docs/connect-turso | All drivers https://orm.drizzle.team/docs/connect-overview

All Cloudflare-specific driver setup, migrations, D1 HTTP access, Durable Objects, and Hyperdrive guidance lives in the companion doc `./cloudflare.md`.

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

For Cloudflare Hyperdrive, read `./cloudflare.md`.

## Transactions & batching

Docs: Transactions https://orm.drizzle.team/docs/transactions | Batch https://orm.drizzle.team/docs/batch-api

### Prefer no transaction at all

**Transactions are the first thing that breaks under load.** They hold locks, hog connections, and cause contention. Before reaching for any transaction or batch, ask yourself: do I actually need atomicity here? Most writes are idempotent or can be retried independently. If a partial failure is acceptable (e.g. an export that can be re-run), use plain sequential queries with no transaction wrapper.

For SQLite drivers that support batching (D1, libSQL/Turso, Durable Object SQLite), prefer `db.batch()` over `Promise.all()` when running multiple independent database statements at the same time. `Promise.all()` sends separate database requests and adds extra round trips; `db.batch()` sends the statements together and executes them in order. Use `Promise.all()` for non-database async work like encryption, HTTP calls, file reads, or CPU prep before building the SQL statements.

Only use `db.batch()` when you genuinely need atomicity (all-or-nothing). Never use `db.transaction()` (interactive transactions) at all.

### If you need atomicity, use `db.batch()`, NEVER `db.transaction()`

**Never use `db.transaction()`.** It holds an open database transaction across multiple round-trips, one per statement. This causes serious problems in production:
- Transactions last too long (each statement waits for a network round-trip before the next one starts)
- They hog database connections and locks, starving other requests
- They fail frequently even at low RPS because of lock contention and timeouts
- On serverless/edge (Cloudflare Workers, Vercel), cold starts make it even worse

**Use `db.batch()` instead** when atomicity is required, or when you would otherwise run multiple SQLite statements in `Promise.all()`. It sends all statements in a single request. The database wraps them in an implicit transaction (BEGIN → statements → COMMIT). If any statement fails, the whole batch rolls back. Same atomicity guarantees, zero round-trip overhead.

```ts
const [newUsers, updatedPosts, allComments] = await db.batch([
  db.insert(users).values({ name: 'Alice' }).returning(),
  db.update(posts).set({ status: 'published' }).where(orm.eq(posts.id, 1)).limit(1),
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

**Multiple SQLite reads:**

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

## Foreign key ordering in grouped writes

**Always read the schema before writing insert/update code.** Trace the foreign key dependency chain and make sure parent rows exist before inserting child rows. This applies to `Promise.all`, `db.batch()`, and any grouped write pattern.

When running multiple inserts in parallel with `Promise.all`, child tables that reference parent tables via foreign keys **must wait** for the parent inserts to complete first. Running them all in a single parallel step causes intermittent FK constraint violations in production. Prefer `db.batch()` for SQLite so the statements are sent together and execute in order.

### How to think about it

1. Read the schema and draw the FK dependency chain
2. Group tables into layers: tables with no FK dependencies go in layer 1, tables that reference layer 1 go in layer 2, etc.
3. Execute each layer sequentially. For SQLite, use one `db.batch()` per layer instead of `Promise.all()` when possible

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

## Migrations

### Use drizzle-kit generate as a starting point, then write the final migration manually

Drizzle-orm does not read migration files at runtime; they are pure output. The database's own migration system (D1's `wrangler d1 migrations apply`, Postgres `drizzle-kit migrate`, libSQL `drizzle-kit migrate`) tracks which files have been applied.

**Use `drizzle-kit generate` to get the SQL diff as a starting point.** Then review, improve, and adapt it into the final migration file. Never blindly commit the generated output. Improvements include: adding comments, simplifying SQLite ALTER TABLE sequences, adding data migrations or backfills, and working around SQLite DDL limitations.

**Workflow:**

1. Edit `schema.ts` with the new table/column definitions
2. Run `drizzle-kit generate` to get a starting point SQL diff
3. Read the generated SQL and adapt it into the final migration file
4. For D1: create a flat `.sql` file (D1 cannot read drizzle-kit's subdirectory format); see `./cloudflare.md`
5. For Postgres/libSQL: the generated file can be used directly after review
6. Apply the migration with the database's native tool

If `drizzle-kit generate` fails (interactive prompts on renames, TTY errors in CI), write the migration SQL directly instead. Read existing migration files and `schema.ts` to understand the current and desired state.

**Before writing any migration, always read:**
- All existing `.sql` migration files in the migrations directory (to know the current DB state)
- The `schema.ts` file (to know the desired state)
- The type mapping for your dialect (see `./cloudflare.md` for SQLite/D1, or the Postgres section below)

This is critical because each migration builds on all previous ones. You cannot write correct SQL without knowing what tables, columns, indexes, and constraints currently exist.

For **D1/SQLite** projects, see `./cloudflare.md` for the full D1 migration workflow.

For **Durable Objects**, write migrations manually and also update `migrations.js` with the new import entry so `migrator.migrate()` picks it up at runtime.

### Apply migrations

```bash
# D1 — use wrangler, not drizzle-kit
wrangler d1 migrations apply DB --remote
wrangler d1 migrations apply DB --local

# Postgres, libSQL/Turso — use drizzle-kit
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

Cloudflare-specific migration rules, SQLite type mapping, and DDL limitations live in `./cloudflare.md`.
