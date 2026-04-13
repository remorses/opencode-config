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

## Framework: Spiceflow with Vite

Always use Spiceflow as the web framework for Workers. Load the `spiceflow` skill first — it has the full API reference and conventions.

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

export default defineConfig({
  plugins: [react(), spiceflowPlugin({ entry: './src/app.tsx' })],
})
```

Entry file is always `src/app.tsx` — uses JSX for `.page()` routes.

## Configuration: wrangler.jsonc

Always use `wrangler.jsonc` (not `wrangler.toml`). Newer features are exclusive to the JSON format.

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
// These are all global — no import required
// Note: wrangler generates DurableObjectNamespace without a generic param,
// so do NOT annotate the return type with DurableObjectStub<MyDO> — just
// let TypeScript infer it.
function getStub(env: Env) {
  const id = env.MY_STORE.idFromName('main')
  return env.MY_STORE.get(id)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const stub = getStub(env)
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

`wrangler types` generates `DurableObjectNamespace` without the generic type param, so the stub type is `DurableObjectStub<undefined>` — RPC methods are invisible. Fix this with a `src/env.d.ts` that augments the global `Env`:

```ts
// src/env.d.ts
import type { MyStore } from './my-store.ts'

declare global {
  interface Env {
    MY_STORE: DurableObjectNamespace<MyStore>
  }
}
```

This re-declares the binding with the correct generic, making RPC methods type-safe on the stub. The `declare global` merges with the wrangler-generated `Env` interface.

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

### Setting secret values

```bash
# Set for production
wrangler secret put API_KEY
wrangler secret put API_KEY --env preview

# For local development, create .dev.vars
echo 'API_KEY=dev-key-here' >> .dev.vars
```

`.dev.vars` is gitignored and only used by `wrangler dev` / `vite dev`.

## Routing: prefer custom_domain

Always use `custom_domain` instead of `routes` for binding a domain to a worker. Custom domains work without needing a proxied A/AAAA DNS record first — Cloudflare creates it automatically.

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

## Environments: preview and production

Every project has two environments. Preview is the default for development and testing.

### wrangler.jsonc structure

**Critical: bindings are NOT inherited by environments.** Wrangler environments do not inherit `durable_objects`, `kv_namespaces`, `secrets`, `r2_buckets`, etc. from the top level. You MUST duplicate all bindings in both top-level (production) and `env.preview`. If you don't, `wrangler types` generates optional (`?`) types for bindings that only exist in one environment, causing `possibly undefined` errors everywhere.

Only `vars` values need to differ between environments. Everything else (bindings, secrets, migrations) should be identical.

```jsonc
{
  "name": "my-worker",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": "dist/server/index.js",

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
      "routes": [
        { "pattern": "app.preview.example.com", "custom_domain": true, "zone_name": "example.com" }
      ]
    }
  }
}
```

### Deploy scripts

```json
{
  "scripts": {
    "deploy": "wrangler deploy --env preview",
    "deploy:prod": "wrangler deploy"
  }
}
```

- `pnpm deploy` → deploys to **preview** (safe default, use for testing)
- `pnpm deploy:prod` → deploys to **production**

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
    "deploy": "wrangler deploy --env preview",
    "deploy:prod": "wrangler deploy"
  }
}
```
