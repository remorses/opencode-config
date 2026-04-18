---
name: cloudflare-workers
description: >
  Cloudflare Workers and Durable Objects conventions for TypeScript projects.
  Covers wrangler.jsonc configuration, type-safe env via `wrangler types` and
  `import { env } from 'cloudflare:workers'`, secrets.required for typed secrets,
  custom_domain for routing, preview/production environments, deploy scripts,
  Durable Objects with SQLite, and Spiceflow as the web framework with Vite.
  ALWAYS load this skill when a project uses wrangler, Cloudflare Workers,
  Durable Objects, or deploys to Cloudflare. Load it before writing any
  wrangler config, worker code, or deploy scripts.
---

# Cloudflare Workers

Conventions for Cloudflare Workers and Durable Objects in TypeScript projects.

## Framework: Spiceflow with Vite + @cloudflare/vite-plugin

Always use Spiceflow as the web framework for Workers. Load the `spiceflow` skill first — it has the full API reference and conventions.

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

export default defineConfig({
  plugins: [
    react(),
    spiceflowPlugin({ entry: './src/app.tsx' }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
```

Entry file is always `src/app.tsx` — uses JSX for `.page()` routes. The entry file also exports the Cloudflare Worker `default` fetch handler and any DO class re-exports. **No separate `worker.ts` file** — the app.tsx IS the worker entry.

```jsonc
// wrangler.jsonc — main points to spiceflow's entrypoint, NOT dist/
{
  "main": "spiceflow/cloudflare-entrypoint"
}
```

```tsx
// src/app.tsx — export DO classes and default fetch handler alongside the app
import { Spiceflow } from 'spiceflow'
import { env } from 'cloudflare:workers'

export { MyStore } from './my-store.ts'

export const app = new Spiceflow()
  .page('/', async () => <h1>Home</h1>)
  // ... routes

// Access env via `import { env } from 'cloudflare:workers'` anywhere — no need
// for .state('env') or threading env through handle(). The import works in any
// file, not just the fetch handler.
export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
```

## Configuration: wrangler.jsonc

Always use `wrangler.jsonc` (not `wrangler.toml`). Newer features are exclusive to the JSON format.

### compatibility_date: ALWAYS use today's date

**MUST:** Always set `compatibility_date` to today's date (or the most recent date possible) when creating a new worker or updating an existing one. Old dates disable newer runtime features like `WeakRef`, `FinalizationRegistry`, and other JS globals — causing cryptic "X is not defined" errors at runtime. There is no benefit to using an old date unless you are pinning behavior for a production worker you cannot test.

```jsonc
{
  // GOOD — use today's date (2026-04-14 or later)
  "compatibility_date": "2026-04-14",

  // BAD — disables WeakRef, FinalizationRegistry, and other modern APIs
  // "compatibility_date": "2025-01-01"
}
```

## Type-safe environment

### Generate types with `wrangler types`

`wrangler types` generates a `worker-configuration.d.ts` file with a typed `Env` interface derived from your `wrangler.jsonc` bindings. This replaces `@cloudflare/workers-types` entirely.

```bash
# Add to package.json scripts
"types": "wrangler types"
```

**After generating types:**
1. **Uninstall** `@cloudflare/workers-types` — it conflicts with generated runtime types
2. **Install** `@types/node` if using `nodejs_compat`
3. **Include** `worker-configuration.d.ts` in tsconfig:

```json
{
  "compilerOptions": {
    "types": []
  },
  "include": ["src", "worker-configuration.d.ts"]
}
```

4. **Rerun** `wrangler types` every time you change `wrangler.jsonc`

### NEVER define custom Env types

The generated `worker-configuration.d.ts` declares a global `Env` interface. Never create your own `Env` type or interface. All bindings, vars, and secrets are available on `Env` automatically.

```ts
// BAD — never do this
export interface Env {
  MY_KV: KVNamespace
  API_KEY: string
}

// GOOD — Env is global from worker-configuration.d.ts
// Just use it directly in your code
export class MyDO extends DurableObject<Env> { ... }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) { ... }
} satisfies ExportedHandler<Env>
```

### Importing common types

The generated types include all Cloudflare runtime types. Import only from `cloudflare:workers` for Worker-specific classes:

```ts
// DurableObject base class
import { DurableObject } from 'cloudflare:workers'

// For accessing env from anywhere (not just fetch handler)
import { env } from 'cloudflare:workers'
```

All other types are available globally from the generated file — `DurableObjectState`, `DurableObjectStorage`, `KVNamespace`, `ExecutionContext`, `ExportedHandler`, `DurableObjectNamespace`, `DurableObjectStub`, etc. No imports needed.

```ts
import { env } from 'cloudflare:workers'

// Access env from the cloudflare:workers import — no function params needed.
// Note: wrangler generates DurableObjectNamespace without a generic param,
// so do NOT annotate the return type with DurableObjectStub<MyDO> — just
// let TypeScript infer it. Fix with env.d.ts augmentation (see below).
function getStub() {
  const id = env.MY_STORE.idFromName('main')
  return env.MY_STORE.get(id)
}

export default {
  async fetch(request: Request): Promise<Response> {
    const stub = getStub()
    // Call named RPC methods — do NOT use stub.fetch()
    return stub.handleRequest(request)
  },
} satisfies ExportedHandler<Env>
```

### Avoid overriding fetch() on Durable Objects

Prefer **named RPC methods** over overriding `fetch()` on DOs. RPC methods are type-safe, self-documenting, and avoid the legacy fetch-based routing pattern.

```ts
// GOOD — named RPC methods
export class MyStore extends DurableObject<Env> {
  async handleRequest(request: Request): Promise<Response> { ... }
  async hranaHandler(request: Request): Promise<Response> { ... }
  async restore(timestamp: number) { ... }
}

// BAD — overriding fetch()
export class MyStore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> { ... }
}
```

The worker calls `stub.handleRequest(request)` or `stub.hranaHandler(request)` directly — clear what each method does, and TypeScript checks the call.

### Fixing DurableObjectNamespace generics

`wrangler types` generates `DurableObjectNamespace` without the generic type param, so the stub type is `DurableObjectStub<undefined>` — RPC methods are invisible. Interface augmentation doesn't work because the existing property type wins in the intersection.

Fix with a typed helper that casts the stub return:

```ts
// src/get-stub.ts
import { env } from 'cloudflare:workers'
import type { MyStore } from './my-store.ts'

export function getStub() {
  const id = env.MY_STORE.idFromName('main')
  return env.MY_STORE.get(id) as DurableObjectStub<MyStore>
}
```

Import and call `getStub()` instead of accessing `env.MY_STORE` directly.

## Secrets

### Declare secrets in wrangler.jsonc

Use `secrets.required` to declare secrets. This makes `wrangler types` generate typed `string` properties on `Env`, and `wrangler deploy` validates they are set.

```jsonc
{
  "secrets": {
    "required": ["API_KEY", "DB_PASSWORD", "AUTH_SECRET"]
  }
}
```

After adding secrets, rerun `wrangler types`. The generated `Env` will include:

```ts
interface Env {
  API_KEY: string;
  DB_PASSWORD: string;
  AUTH_SECRET: string;
  // ... other bindings
}
```

### Local development: use Doppler, not `.env`

Do **not** use checked-in `.env` files for Worker local development in this workspace. Use Doppler to inject local env vars and secrets into `wrangler dev` / `vite dev` instead.

Wrangler local dev now loads local dev vars from `.env` files or the process environment, so `doppler run` works fine for local Worker runtime bindings. Keep `secrets.required` in `wrangler.jsonc` so local dev only loads the keys the Worker actually expects.

```bash
# Local wrangler dev
doppler run -c development -- wrangler dev

# Local vite dev against preview env
CLOUDFLARE_ENV=preview doppler run -c preview -- vite dev

# Preview build + deploy
CLOUDFLARE_ENV=preview doppler run -c preview -- vite build && wrangler deploy --env preview
```

Rules:

- **Prefer Doppler over `.env` / `.dev.vars`** for local development.
- **Put shell env vars before `doppler run`, never after.**
- Read runtime values from `import { env } from 'cloudflare:workers'`, not `process.env`, even though `process.env` may be populated under `nodejs_compat`.

### Upload secrets from Doppler to Cloudflare

Cloudflare Workers store their own deployed secret values. Local `doppler run` is only for local development — it does **not** upload secrets to Cloudflare. Sync them explicitly with `wrangler secret bulk`.

```json
{
  "scripts": {
    "secrets:preview": "doppler run -c preview --mount .env.preview --mount-format env -- wrangler secret bulk --env preview .env.preview",
    "secrets:prod": "doppler run -c production --mount .env.prod --mount-format env -- wrangler secret bulk .env.prod"
  }
}
```

Run these whenever Worker secrets change:

```bash
pnpm secrets:preview
pnpm secrets:prod
```

Do **not** loop over `wrangler secret put` one key at a time. It is interactive and hangs in scripts. Always use `wrangler secret bulk`.

### Production / preview secret values

```bash
# Set for production
wrangler secret put API_KEY
wrangler secret put API_KEY --env preview
```

Prefer the bulk upload scripts above over manual `secret put` commands.

## Importing non-JS files as text

For things like `.txt`, `.md`, and `.sql`, tell Wrangler/Vite to import them as text with `rules`, then add a TypeScript declaration file. Do **not** silence the import with `// @ts-expect-error`.

```jsonc
{
  "rules": [
    { "type": "Text", "globs": ["**/*.sql"], "fallthrough": true },
    { "type": "Text", "globs": ["**/*.md", "**/*.txt"], "fallthrough": true }
  ]
}
```

```ts
// src/import-text.d.ts
declare module '*.sql' {
  const content: string
  export default content
}

declare module '*.md' {
  const content: string
  export default content
}

declare module '*.txt' {
  const content: string
  export default content
}
```

```ts
import schemaSql from './schema.sql'
import promptMd from './prompt.md'
import fixtureTxt from './fixture.txt'
```

Use a real `declare module` file so TypeScript understands the import shape. Never paper over missing module types with `@ts-expect-error`.

## Routing: prefer custom_domain when you actually need routing

Do **not** add `routes` / `custom_domain` entries just because a project uses Spiceflow, Vite, or `@cloudflare/vite-plugin`. Spiceflow does not need wrangler routing rules to run, build, or deploy, and Vite does not need them either.

Only add `routes` when you are intentionally binding a real hostname to the worker. If you do need that, prefer `custom_domain` instead of path-based `routes`. Custom domains work without needing a proxied A/AAAA DNS record first — Cloudflare creates it automatically.

```jsonc
{
  // GOOD — custom_domain, no DNS setup needed
  "routes": [
    { "pattern": "api.example.com", "custom_domain": true },
    { "pattern": "api.preview.example.com", "custom_domain": true, "zone_name": "example.com" }
  ]

  // BAD — requires pre-existing proxied DNS record
  // "routes": [
  //   { "pattern": "api.example.com/*", "zone_name": "example.com" }
  // ]
}
```

Use `routes` (non-custom_domain) only when you need path-based routing (`example.com/api/*`) on a domain that already has another worker or Pages project on the root.

If you are using the default `*.workers.dev` hostname, or you have not decided on a custom domain yet, leave `routes` out entirely.

## Environments: preview and production

Every project has two environments. Preview is the default for development and testing.

### wrangler.jsonc structure

**Critical: bindings are NOT inherited by environments.** Wrangler environments do not inherit `durable_objects`, `kv_namespaces`, `secrets`, `r2_buckets`, etc. from the top level. You MUST duplicate all bindings in both top-level (production) and `env.preview`. If you don't, `wrangler types` generates optional (`?`) types for bindings that only exist in one environment, causing `possibly undefined` errors everywhere.

Only `vars` values need to differ between environments. Everything else (bindings, secrets, migrations) should be identical.

```jsonc
{
  "name": "my-worker",
  "compatibility_date": "2026-04-14",
  "compatibility_flags": ["nodejs_compat"],
  "main": "spiceflow/cloudflare-entrypoint",

  // ── Production (top-level) ──────────────────────────────────
  "durable_objects": {
    "bindings": [{ "name": "MY_STORE", "class_name": "MyStore" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyStore"] }
  ],
  "vars": {
    "APP_URL": "https://app.example.com"
  },
  "secrets": {
    "required": ["API_KEY", "AUTH_SECRET"]
  },
  // Optional: only add this when you want a custom hostname.
  "routes": [
    { "pattern": "app.example.com", "custom_domain": true }
  ],

  // ── Preview ─────────────────────────────────────────────────
  // Must duplicate ALL bindings, secrets, migrations
  "env": {
    "preview": {
      "name": "my-worker-preview",
      "durable_objects": {
        "bindings": [{ "name": "MY_STORE", "class_name": "MyStore" }]
      },
      "migrations": [
        { "tag": "v1", "new_sqlite_classes": ["MyStore"] }
      ],
      "vars": {
        "APP_URL": "https://app.preview.example.com"
      },
      "secrets": {
        "required": ["API_KEY", "AUTH_SECRET"]
      },
      // Optional: only add this when you want a custom hostname.
      "routes": [
        { "pattern": "app.preview.example.com", "custom_domain": true, "zone_name": "example.com" }
      ]
    }
  }
}
```

### Deploy scripts

The `@cloudflare/vite-plugin` resolves and flattens your `wrangler.jsonc` at **build time** and writes it into `dist/rsc/wrangler.json`. Set `CLOUDFLARE_ENV` during `vite build` so the plugin resolves the correct environment section:

`wrangler deploy` deploys **one environment at a time**. It does **not** deploy every configured `env.*` block. With no `--env` flag, Wrangler deploys the top-level/default config (usually production). Use `wrangler deploy --env preview` or another explicit env name when targeting a non-production environment.

```json
{
  "scripts": {
    "deploy": "CLOUDFLARE_ENV=preview vite build && wrangler deploy --env preview",
    "deploy:prod": "vite build && wrangler deploy"
  }
}
```

- `pnpm deploy` → builds for preview env, deploys to **preview** (safe default)
- `pnpm deploy:prod` → builds for production, deploys to **production**

**Preview is the default deploy target.** This prevents accidental production deploys. Production deploys should be deliberate.

### Secrets per environment

Secrets are set per environment. Set them separately:

```bash
# Preview
wrangler secret put API_KEY --env preview

# Production
wrangler secret put API_KEY
```

### Using preview for integration tests

Preview environments are useful for tests that depend on Cloudflare infrastructure (Durable Objects, KV, R2, etc.) which can't be fully emulated locally.

```ts
// test/integration.test.ts
import { describe, test, expect } from 'vitest'

const PREVIEW_URL = 'https://app.preview.example.com'

describe('integration', () => {
  test('health check', async () => {
    const res = await fetch(`${PREVIEW_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  test('auth flow redirects to provider', async () => {
    const res = await fetch(`${PREVIEW_URL}/api/auth/sign-in/social?provider=sigillo`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('auth.sigillo.dev')
  })
})
```

Deploy to preview first, then run tests against it:

```bash
pnpm deploy && pnpm vitest --run test/integration.test.ts
```

## Durable Objects with SQLite

See the `drizzle` skill for full schema and migration conventions. Key wrangler config:

```jsonc
{
  "rules": [
    { "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "MY_STORE", "class_name": "MyStore" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyStore"] }
  ]
}
```

The `rules` entry is required for drizzle DO migrations — imports `.sql` files as text.

## package.json scripts

Standard scripts for a Worker package:

```json
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "types": "wrangler types",
    "deploy": "CLOUDFLARE_ENV=preview vite build && wrangler deploy --env preview",
    "deploy:prod": "vite build && wrangler deploy"
  }
}
```
