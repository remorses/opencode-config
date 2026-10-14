---
title: cf CLI and cloudflare.config.ts
description: >
  How to use the new Cloudflare CLI `cf` (beta) and its typed `cloudflare.config.ts`.
  Covers bindings (D1, KV, R2, AI, Hyperdrive, queues, DOs, secrets), modes instead of
  wrangler envs, auto-provisioning, deploy, migration from wrangler, and creating a
  PlanetScale Postgres database billed through Cloudflare.
---

# cf CLI and cloudflare.config.ts

**`cf`** is the new Cloudflare CLI (beta, `npm i -g cf`). One CLI for the whole Cloudflare API (2900+ generated commands) plus Worker projects. Worker config moves from `wrangler.jsonc` to a typed **`cloudflare.config.ts`**. Wrangler will be sunset after the beta.

```ts
// cloudflare.config.ts
import { bindings, defineConfig } from 'cf/config'
import * as entrypoint from './src/app.tsx' with { type: 'cf-worker' }

export default defineConfig(({ mode }) => ({
  worker: {
    name: mode === 'preview' ? 'my-app-preview' : 'my-app',
    entrypoint,
    compatibilityDate: '2026-09-14',
    compatibilityFlags: ['nodejs_compat'],
    env: {
      DB: bindings.d1({ name: mode === 'preview' ? 'my-app-preview' : 'my-app' }),
      CACHE: bindings.kv(),
      AI: bindings.ai(),
      API_KEY: bindings.secret(),
    },
  },
}))
```

```bash
cf dev                     # vite dev, mode "development"
cf deploy --mode preview   # build + upload + deploy, creates missing D1/KV/R2
cf deploy                  # mode "production"
```

Docs: https://developers.cloudflare.com/cf/ (append `index.md` to any page for markdown, index at https://developers.cloudflare.com/cf/llms.txt). Source: https://github.com/cloudflare/cf

## When to use cf vs wrangler

| Project has | Use |
| --- | --- |
| `cloudflare.config.ts` | `cf dev`, `cf build`, `cf deploy` |
| `wrangler.jsonc` only | wrangler for dev/deploy; `cf` only for API commands (DNS, analytics, logs, ...) |
| `wrangler.jsonc` and you want cf | `cf migrate` first |

**Never** run `cf init .`, `cf dev`, `cf build` or `cf deploy` in a wrangler project without `cloudflare.config.ts`. Auto-configuration ignores `wrangler.jsonc` and writes a new config with no bindings.

Requirements:

- Node **22.18+**. Loading `cloudflare.config.ts` fails on Bun. Every `cf` command inside the project loads it, even pure API commands.
- `"type": "module"` in package.json.
- `cf` as a devDependency (`pnpm add -D cf`) so `cf/config` resolves.
- Vite projects use `@cloudflare/vite-plugin@beta` (2.0, no wrangler dependency).

## Region: always IAD (Ashburn, Virginia)

**Always put every regional resource in IAD.** Each product names it differently:

| Resource | Value | Where |
| --- | --- | --- |
| PlanetScale DB (Postgres, Vitess) | `us-east` (AWS us-east-1) | `pscale database create --region us-east` |
| Worker placement | `aws:us-east-1` | `worker.placement: { region: 'aws:us-east-1' }` |
| D1 primary | `enam` | `cf d1 create --primary-location-hint enam` |
| R2 bucket | `enam` | `cf r2 buckets create --location-hint enam` |
| Durable Object | `enam` | `ns.get(id, { locationHint: 'enam' })` |

- **PlanetScale defaults to `aws-us-east-2` (Ohio)**, not IAD. Always pass `--region us-east`. The region of a branch cannot change later.
- Without a hint, D1 and R2 are created **near the machine that runs the command** (Europe for us). So create D1 and R2 yourself with `enam`; do not let `cf deploy` auto-provision them.
- `enam` is the only IAD option for D1, R2 and DOs. It means "Eastern North America", not one exact data center.
- Worker placement only matters when the Worker talks to a regional backend (PlanetScale, D1 primary, an external API). Use `aws:us-east-1` so the Worker and the PlanetScale DB run in the same AWS region.

## Discover API commands

```bash
cf auth whoami                         # not logged in? ask the user to run `cf auth login`
cf cli search "create a D1 database"   # 5 JSON matches, local, no credentials
cf d1 create --help                    # flags of the chosen command
cf schema d1 create                    # raw API request: path, params, body fields
cf d1 create --name my-db --dry-run    # print the request, send nothing
```

- Keep search queries anonymous: no domains, emails or IDs.
- Output is JSON on stdout, messages on stderr. Pipe to `jq`.
- Destructive commands without `--force` in non-TTY print `Aborted.` and **exit 0**. Exit 0 does not mean deleted.
- Resource commands take **IDs**, not names (`cf d1 migrations apply <DATABASE_ID>`).
- `--local` works only for KV keys, R2 objects, `cf d1 raw`, `cf d1 migrations list/apply`.
- CI: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Useful commands:

```bash
cf d1 create --name my-app
cf d1 list
cf d1 raw <DATABASE_ID> --sql 'select count(*) from user'
cf d1 migrations apply <DATABASE_ID> --dir ./drizzle --pattern './drizzle/*/migration.sql'
cf kv namespaces create --title my-app-cache
cf r2 buckets create --name my-app-uploads
cf ai models list
cf ai run ...                          # run a Workers AI model from the terminal
cf logs query ...                      # query Worker logs
cf observability telemetry query ...   # traces and logs from Workers observability
cf dns records create ...
cf cache purge ...
```

Not in cf yet, use `npx wrangler` with `--name <WORKER>`: `wrangler tail`, `wrangler secret put`.

## cloudflare.config.ts

### Shape

```
defineConfig(obj | promise | ({ mode, isPreview }) => obj)
│
├── accountId?            default account for every cf command
├── complianceRegion?     'public' | 'fedramp-high'
├── containers?           defineContainer(...)[]
└── worker
    ├── name, compatibilityDate, entrypoint        required (entrypoint unless assets-only)
    ├── compatibilityFlags, placement, limits, observability, workersDev, previewUrls
    ├── domains: ['app.example.com']               custom domains (was custom_domain routes)
    ├── assets: { notFoundHandling, runWorkerFirst, htmlHandling }   runtime only
    ├── env: { NAME: bindings.x(...) }             bindings → typed `Env`
    ├── triggers: [triggers.fetch|queue|scheduled|email|connect(...)]
    └── exports: { ClassName: exports.durableObject|workflow|worker(...) }
```

The `with { type: 'cf-worker' }` import is **not executed**. cf only reads the path, and TypeScript infers exported classes and RPC types from it.

Types: the Vite plugin writes `.cloudflare/types/index.d.ts` on dev/build. Outside Vite run `cf workers types`. Typecheck script: `cf workers types && tsc`. The file infers `Env` from `typeof import('cloudflare.config').default`, so binding edits show up in the editor **without regenerating**. Regenerate only for runtime types.

```json
{
  "compilerOptions": { "allowImportingTsExtensions": true, "noEmit": true },
  "include": ["src", "cloudflare.config.ts", ".cloudflare/types"]
}
```

Add `.cloudflare/` to `.gitignore`. It holds build output, types and local dev state.

Build settings are **not** in `cloudflare.config.ts`. Static assets dir, aliases, define, sourcemaps go in `vite.config.ts`:

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [cloudflare()],
})
```

### Bindings

| Area | Builders |
| --- | --- |
| Inline values | `text`, `json`, `secret` |
| Storage | `d1`, `kv`, `r2`, `hyperdrive`, `analyticsEngineDataset`, `artifacts`, `pipeline` |
| AI and media | `ai`, `aiSearch`, `aiSearchNamespace`, `agentMemory`, `browser`, `images`, `media`, `stream`, `vectorize` |
| Messaging | `queue`, `sendEmail` |
| Composition | `assets`, `dispatchNamespace`, `durableObject`, `worker`, `workerLoader`, `workflow` |
| Network | `mtlsCertificate`, `rateLimit`, `secretsStoreSecret`, `vpcNetwork`, `vpcService` |
| Metadata | `flagship`, `logfwdr`, `versionMetadata` |

```ts
import { bindings, defineConfig, exports, triggers } from 'cf/config'
import * as entrypoint from './src/app.tsx' with { type: 'cf-worker' }

type Job = { id: string; operation: 'index' | 'delete' }

export default defineConfig({
  worker: {
    name: 'my-app',
    entrypoint,
    compatibilityDate: '2026-09-14',
    compatibilityFlags: ['nodejs_compat'],
    env: {
      APP_URL: bindings.text('https://app.example.com'),   // env.APP_URL: literal type
      FEATURES: bindings.json({ search: true }),
      AUTH_SECRET: bindings.secret(),                       // replaces secrets.required

      DB: bindings.d1({ name: 'my-app' }),                  // id optional
      CACHE: bindings.kv(),                                 // id optional
      UPLOADS: bindings.r2({ name: 'my-app-uploads' }),
      JOBS: bindings.queue<Job>({ name: 'my-app-jobs' }),   // env.JOBS: Queue<Job>

      AI: bindings.ai(),                                    // Workers AI, typed model list
      VECTORS: bindings.vectorize({ name: 'my-app-index' }),
      BROWSER: bindings.browser(),
      EMAIL: bindings.sendEmail({ allowedSenderAddresses: ['hi@example.com'] }),
      LOADER: bindings.workerLoader(),                      // dynamic workers
      RATE_LIMITER: bindings.rateLimit({ namespace: '1001', simple: { limit: 100, period: 60 } }),

      STORE: bindings.durableObject({ worker: 'my-app', exportName: 'MyStore' }),
    },
    exports: {
      MyStore: exports.durableObject({ storage: 'sqlite' }), // replaces migrations[]
    },
    triggers: [
      triggers.scheduled({ schedule: '*/5 * * * *' }),
      triggers.queue({ name: 'my-app-jobs', maxBatchSize: 10, maxRetries: 3 }),
    ],
    domains: ['app.example.com'],
  },
})
```

Local dev against the real resource: `dev: { remote: true }` on the binding (was `remote: true` in wrangler).

### Auto-provisioning

`cf deploy` **creates missing resources** for bindings without an ID, then deploys. It does **not** write the new IDs back to the config. Disable with `--no-provision`.

Provisionable: **KV, D1, R2, Queues, AI Search namespace, Agent Memory, dispatch namespace, Flagship**.

Not provisionable: **Hyperdrive** (`id` is required), Vectorize, AI Search instances. Create these first with `cf`.

Prefer `name` over `id` for D1 and R2 so the config is readable and stable across machines.

**Auto-provisioned D1 and R2 get no location hint**, so they land near the deploying machine. Create them first in IAD, then deploy:

```bash
cf d1 create --name my-app --primary-location-hint enam
cf r2 buckets create --name my-app-uploads --location-hint enam
```

### Durable Objects: exports instead of migrations

`worker.exports` replaces the ordered `migrations` array. Keep live classes in the map; add tombstones only for pending changes.

```ts
exports: {
  Counter: exports.durableObject({ storage: 'sqlite' }),
  OldCounter: exports.durableObject({ state: 'renamed', renamedTo: 'Counter' }),
  Legacy: exports.durableObject({ state: 'deleted' }),
}
```

- Live DO classes appear on `ctx.exports.Counter`, so the same Worker needs **no env binding** to call its own class.
- Remove a tombstone only after a deploy response reports it as stale.
- Use `cf deploy` (not a version upload) for lifecycle changes. They cannot be rolled back.
- Migrating from wrangler: declare every currently live class once; do not copy applied renames/deletes.

### Modes replace wrangler environments

No environment inheritance. The config function returns **one complete config per mode**. A mode deploys a separate Worker only if it returns a different `name`.

| Command | Default mode |
| --- | --- |
| `cf dev` (Vite) | `development` |
| `cf build`, `cf deploy` (Vite) | `production` |
| API commands, Wrangler-bundled builds | `undefined` |

```ts
// cloudflare.config.ts with preview and production
import { bindings, defineConfig } from 'cf/config'
import * as entrypoint from './src/app.tsx' with { type: 'cf-worker' }

const resources = {
  production: { suffix: '', hyperdriveId: '<PROD_HYPERDRIVE_ID>', domain: 'app.example.com' },
  preview: { suffix: '-preview', hyperdriveId: '<PREVIEW_HYPERDRIVE_ID>', domain: 'app.preview.example.com' },
} as const

export default defineConfig(({ mode }) => {
  const stage = mode === 'preview' ? 'preview' : 'production' // development uses production names + local state
  const r = resources[stage]
  return {
    worker: {
      name: `my-app${r.suffix}`,
      entrypoint,
      compatibilityDate: '2026-09-14',
      compatibilityFlags: ['nodejs_compat'],
      domains: mode === 'development' ? [] : [r.domain],
      env: {
        DB: bindings.d1({ name: `my-app${r.suffix}` }),
        HYPERDRIVE: bindings.hyperdrive({ id: r.hyperdriveId }),
        APP_URL: bindings.text(`https://${r.domain}`),
        AUTH_SECRET: bindings.secret(),
      },
    },
  }
})
```

```bash
cf deploy --mode preview
cf deploy                          # production
cf build --mode preview && cf deploy --prebuilt --mode preview   # CI split
```

- `--prebuilt` deploys must pass the **same `--mode`** the build recorded (`.cloudflare/output/v0/config.json`).
- `cf previews deploy` deploys a per-branch Worker Preview with `isPreview: true`.
- Keep `accountId` independent of mode: API commands evaluate it with `mode: undefined`.
- Real-world example of a shared base config + modes: https://github.com/usemarble/marble/tree/main/packages/cf-config

### Secrets

Declare with `bindings.secret()`. Upload with the deploy:

```bash
sigillo run -c preview --mount ./tmp/secrets.env --mount-format env \
  -- cf deploy --mode preview --secrets-file ./tmp/secrets.env
```

`--secrets-file` takes `.env` or JSON. There is no `cf secret put` yet.

### Package scripts

`cf build`/`cf deploy` do **not** run your package.json `build` script. They call the framework command (`vite build`) directly. Chain extra steps yourself:

```json
{
  "scripts": {
    "dev": "cf dev",
    "typecheck": "cf workers types && tsc",
    "deploy": "pnpm typecheck && cf d1 migrations apply $PREVIEW_D1_ID && cf deploy --mode preview",
    "deploy:prod": "pnpm typecheck && cf d1 migrations apply $PROD_D1_ID && cf deploy"
  }
}
```

`cf dev` rejects extra args in Vite projects (`--port` fails). Set `server.port` in `vite.config.ts`.

## PlanetScale Postgres billed through Cloudflare

**Yes, it works with cf, but not from the config.** `cloudflare.config.ts` has no PlanetScale resource and `bindings.hyperdrive()` requires an existing `id`. Create the database and the Hyperdrive config once with CLIs, then bind the Hyperdrive ID.

```
cf hyperdrive integration planetscale signature        signed billing token (short-lived)
        │
        ▼  stdin
pscale database create --cloudflare-billing @-          DB billed on the Cloudflare invoice
        │
        ▼
cf hyperdrive create --integration-provider planetscale  pooled + cached connection, returns id
        │
        ▼
bindings.hyperdrive({ id })  ──►  env.HYPERDRIVE.connectionString  ──►  pg / postgres.js
```

### 1. Create the database

Needs `pscale` v0.313.0+ logged in to your PlanetScale org, and a Cloudflare account entitled to Cloudflare-billed databases (pay-as-you-go works).

```bash
cf hyperdrive integration planetscale signature | \
  pscale database create my-app \
    --org <PLANETSCALE_ORG> \
    --engine postgresql \
    --region us-east \
    --cloudflare-billing @- \
    --format json
```

- `--engine postgresql`: pscale defaults to Vitess (MySQL).
- `@-` reads the signature from stdin. Treat it as a credential.
- Official docs show the same pipe with `npx wrangler hyperdrive planetscale signature`. The `cf` command calls the same API (`createDatabaseSignature`).
- Billing: daily from creation until deletion, at PlanetScale prices, as a line item on the Cloudflare invoice.
- Dashboard alternative: https://dash.cloudflare.com/?to=/:account/workers/hyperdrive?modal=1&type=planetscale&step=1

### 2. Create the Hyperdrive config

Managed integration (account must be linked to PlanetScale in the Hyperdrive dashboard; the dashboard flow above does this):

```bash
cf hyperdrive create \
  --name my-app \
  --integration-provider planetscale \
  --integration-organization-name <PLANETSCALE_ORG> \
  --integration-database-name my-app \
  --integration-database-branch-name main \
  --integration-scheme postgres
```

Or with a plain connection string (any Postgres, including PlanetScale roles with `pg_read_all_data` + `pg_write_all_data`): run `cf schema hyperdrive create` for the `origin` body shape and pass it with `--body`.

One branch per mode: create a `preview` PlanetScale branch and a second Hyperdrive config pointing at it.

### 3. Bind and query

```ts
// cloudflare.config.ts
env: {
  HYPERDRIVE: bindings.hyperdrive({
    id: '<HYPERDRIVE_ID>',
    dev: { connectionString: 'postgres://postgres:postgres@localhost:5432/my_app' },
  }),
},
compatibilityFlags: ['nodejs_compat'],
placement: { region: 'aws:us-east-1' }, // IAD, same AWS region as PlanetScale us-east
```

`dev.connectionString` replaces wrangler's `localConnectionString`. You can also set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in the env instead of committing it.

```ts
// src/db.ts
import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'
import * as schema from './schema.ts'

// new client per request is cheap: Hyperdrive holds the real pool
export async function getDb() {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString })
  await client.connect()
  return drizzle(client, { schema })
}
```

- Use `pg` >= 8.16.3 or `postgres.js`. **Not** the PlanetScale serverless driver.
- Hyperdrive caches reads and does not invalidate them on writes. For auth, sessions or permissions reads, add a second Hyperdrive config with caching disabled.
- Placement next to the DB matters when one request runs many queries.

## Migrate a wrangler project

```bash
cf migrate --dry-run   # preview
cf migrate             # writes cloudflare.config.ts, adds cf
```

Then resolve every `TODO(@cloudflare)` in the generated file; the build fails until they are gone. Hand-finish:

- `main` string → `cf-worker` import for typed exports.
- `env.preview` blocks → `switch (ctx.mode)` cases. Use `--mode preview` instead of `--env preview`.
- `migrations` → `worker.exports` (not converted automatically).
- `durable_objects.bindings`, `workflows`, `containers`, preview resource IDs: review by hand.
- `assets.directory`, `alias`, `define`, `rules` → `vite.config.ts`.
- D1 `migrations_dir` → `--dir` / `--pattern` flags on `cf d1 migrations apply`.

| wrangler.jsonc | cloudflare.config.ts |
| --- | --- |
| `vars` | `bindings.text()` / `bindings.json()` |
| `secrets.required` | `bindings.secret()` |
| `routes` + `custom_domain: true` | `worker.domains` |
| `routes` with `zone_name` | `triggers.fetch({ pattern, zone })` |
| `triggers.crons` | `triggers.scheduled({ schedule })` |
| `queues.producers` / `consumers` | `bindings.queue()` / `triggers.queue()` |
| `remote: true` | `dev: { remote: true }` |
| `env.<name>` | mode branch in the config function |
| `migrations` | `worker.exports` |

<details>
<summary>Gotchas</summary>

- Importing another `cloudflare.config.ts` (cross-worker bindings) needs the `.ts` extension. Without it every `cf` command in that dir fails with `ERR_MODULE_NOT_FOUND`.
- Use `satisfies Partial<WorkerConfig>` for shared base objects, not `as const`: a readonly `compatibilityFlags` tuple breaks `defineConfig` and empties the inferred `Env`.
- `cf --local` state lives in `~/Library/Preferences/cloudflare/state/v3`, shared by all projects. The dev server uses `.cloudflare/state/` in the project instead.
- `cf` is beta. Config format and build output (`.cloudflare/output/v0/`) can change. Pin the `cf` version in devDependencies.
- Astro 6+ does not build with `cf` during the beta.

</details>
