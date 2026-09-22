# better-auth on a SQLite Durable Object

Use this when auth tables live in a Durable Object, not D1 or Postgres. `ctx.storage.sql.exec` is **sync** and exists only inside the DO isolate. `betterAuth()` must be constructed there.

Most session reads never reach the DO. The Worker verifies the signed `session_data` cookie with `getCookieCache`, then RPCs the DO only on a miss.

This is the exception to the drizzle skill's thin SQL-proxy DO. better-auth runs many queries per sign-in. Put the **auth instance** in the DO. Do not proxy each `findOne` / `create` from the Worker.

Docs: [cookie cache](https://better-auth.com/docs/concepts/session-management) · [drizzle durable-sqlite](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do)

```
Browser / SSR
    │  HTTP  /api/auth/*  or  page loader
    ▼
Worker
    getCookieCache(request)  ►  hit? return session
                         miss?  ►  AUTH_STORE RPC
    ▼
AuthStore DO   idFromName(key)
    drizzle(ctx.storage) + betterAuth()
    sql.exec is sync here
```

`key` is a name you already have. Workspace slug from the host. Tenant id from the path. A fixed `'auth'` string if identity is global.

There is no query across Durable Object SQLite files. Never scan every workspace to find a user. If login does not already know which DO to open, keep a small directory (one Auth DO, or D1) that maps `email → workspaceId`.

## Which DO holds better-auth

better-auth tables (`user`, `session`, `account`) are for **login**. They are not the table you join to messages.

A Slack-style workspace DO should store a **member** row (userId, name, avatar, role) next to channels and messages. Join `message.userId` to `member`. Copy name and avatar onto the message at write time if you want history to stay stable.

Put better-auth itself on the workspace DO only when the login URL already names that workspace (`acme.app.com`, `/w/acme/api/auth`). Then `idFromName(workspaceId)` is fine. Isolated tenants. No cross-workspace Google account.

If one Google user can join many workspaces, login is global. Keep better-auth on one Auth DO or D1. Keep members and messages on the workspace DO. You cannot join those SQLite files. You do not need to. The member row is the join target.

`getAuthStub` takes that same key:

```ts
export function getAuthStub(key: string) {
  const id = env.AUTH_STORE.idFromName(key)
  return env.AUTH_STORE.get(id) as DurableObjectStub<AuthStore>
}
```

## wrangler.jsonc

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "rules": [
    { "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }
  ],
  "durable_objects": {
    "bindings": [{ "name": "AUTH_STORE", "class_name": "AuthStore" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AuthStore"] }
  ],
  "secrets": {
    "required": [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET"
    ]
  }
}
```

Duplicate the binding and migration in `env.preview`. Export `AuthStore` from the worker entry (`src/app.tsx`).

## Shared factory

Value-import this only from the DO. The Worker imports **types** only.

```ts
// src/create-auth.ts
import { betterAuth } from 'better-auth/minimal'
import { drizzleAdapter } from 'better-auth-drizzle-adapter'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as schema from './schema.ts'

export function createAuth(
  db: DrizzleSqliteDODatabase<typeof schema>,
  options: {
    secret: string
    baseURL: string
    googleClientId: string
    googleClientSecret: string
  },
) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    secret: options.secret,
    baseURL: options.baseURL,
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: options.googleClientId,
        clientSecret: options.googleClientSecret,
        prompt: 'select_account',
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 365,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
        strategy: 'compact',
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
export type AuthSession = Auth['$Infer']['Session'] | null
```

Generate tables with `pnpm dlx auth@latest generate`. Date columns use `integer({ mode: 'timestamp_ms' })`. See the drizzle skill Timestamps section.

## Auth DO class

```ts
// src/auth-store.ts
import { DurableObject } from 'cloudflare:workers'
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { createAuth, type Auth, type AuthSession } from './create-auth.ts'
import * as schema from './schema.ts'
import migrations from '../drizzle/migrations'

export type SerializedRequest = {
  url: string
  method: string
  headers: [string, string][]
  body: ArrayBuffer | null
}

export class AuthStore extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase<typeof schema>
  auth: Auth

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db = drizzle(ctx.storage, { schema })
    this.auth = createAuth(this.db, {
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    })
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations)
    })
  }

  async handleAuth(serialized: SerializedRequest): Promise<Response> {
    const request = new Request(serialized.url, {
      method: serialized.method,
      headers: serialized.headers,
      body: serialized.body,
    })
    return this.auth.handler(request)
  }

  async lookupSession(
    headerList: [string, string][],
    disableCookieCache = false,
  ): Promise<{ session: AuthSession; setCookies: string[] }> {
    const headers = new Headers(headerList)
    const { response, headers: out } = await this.auth.api.getSession({
      headers,
      query: disableCookieCache ? { disableCookieCache: true } : undefined,
      returnHeaders: true,
    })
    return {
      session: response,
      setCookies: out.getSetCookie(),
    }
  }
}
```

Do not pass a live `Request` over RPC. Reading the body on both sides can lock the stream. Serialize in the Worker, rebuild in the DO.

## Worker: cache first, stub on miss

```ts
// src/get-session.ts
import { getCookieCache } from 'better-auth/cookies'
import { env } from 'cloudflare:workers'
import type { AuthSession } from './create-auth.ts'
import type { AuthStore, SerializedRequest } from './auth-store.ts'

export function getAuthStub(key: string) {
  const id = env.AUTH_STORE.idFromName(key)
  return env.AUTH_STORE.get(id) as DurableObjectStub<AuthStore>
}

export async function serializeRequest(request: Request): Promise<SerializedRequest> {
  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body: request.body ? await request.arrayBuffer() : null,
  }
}

export async function handleAuthRequest(
  request: Request,
  key: string,
): Promise<Response> {
  return getAuthStub(key).handleAuth(await serializeRequest(request))
}

export async function getSession(
  request: Request,
  key: string,
  options?: { disableCookieCache?: boolean },
): Promise<{ session: AuthSession; setCookies: string[] }> {
  const isSecure = new URL(request.url).protocol === 'https:'

  if (!options?.disableCookieCache) {
    const cached = await getCookieCache(request, {
      secret: env.BETTER_AUTH_SECRET,
      strategy: 'compact',
      isSecure,
    })
    if (cached) {
      return {
        session: { session: cached.session, user: cached.user },
        setCookies: [],
      }
    }
  }

  return getAuthStub(key).lookupSession(
    [...request.headers.entries()],
    options?.disableCookieCache === true,
  )
}
```

Always pass **`secret`**, **`strategy: 'compact'`**, and **`isSecure`**. `getCookieCache` falls back to `NODE_ENV === 'production'` for the `__Secure-` prefix. That is often wrong in workerd. Match the incoming URL.

Do not use `getSessionCookie`. It only checks that a cookie exists. It does not verify the signature.

On a miss, the DO may refresh `session_data`. **Always forward `setCookies`** onto the outgoing response.

## Spiceflow

```ts
// src/app.tsx
import { Spiceflow, json } from 'spiceflow'
import { getSession, handleAuthRequest } from './get-session.ts'
import type { AuthSession } from './create-auth.ts'

export { AuthStore } from './auth-store.ts'

function authKey(request: Request) {
  const host = new URL(request.url).hostname
  return host.split('.')[0] ?? 'auth'
}

export const app = new Spiceflow()
  .use(async ({ request }, next) => {
    if (request.parsedUrl.pathname.startsWith('/api/auth')) {
      const response = await handleAuthRequest(request, authKey(request))
      if (response.ok || response.status !== 404) return response
    }
    return next()
  })
  .state('session', null as AuthSession)
  .state('authSetCookies', [] as string[])
  .use(async ({ request, state }, next) => {
    const result = await getSession(request, authKey(request))
    state.session = result.session
    state.authSetCookies = result.setCookies
    const response = await next()
    if (!response || result.setCookies.length === 0) return response
    const headers = new Headers(response.headers)
    for (const cookie of result.setCookies) {
      headers.append('Set-Cookie', cookie)
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
  .loader('/*', ({ state }) => {
    return { session: state.session }
  })
  .page('/dashboard', async ({ loaderData, redirect }) => {
    if (!loaderData.session) throw redirect('/login')
    return <div>Hello, {loaderData.session.user.name}</div>
  })
  .get('/api/me', ({ state }) => {
    if (!state.session) return json({ message: 'Unauthorized' }, { status: 401 })
    return state.session.user
  })

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
```

Browser client is unchanged: `createAuthClient` from `better-auth/react` talks HTTP to `/api/auth`. It never touches SQLite.

Server actions call `getSession(getActionRequest())`. For money or admin mutations, pass `{ disableCookieCache: true }`.

## When the DO runs

| Path | Hits Auth DO? |
|---|---|
| Page / API with valid `session_data` | No. Worker HMAC only. |
| Cookie missing, expired, or bad sig | Yes. `lookupSession` |
| `/api/auth/*` sign-in, OAuth, sign-out | Yes. `handleAuth` |
| `disableCookieCache: true` | Yes |

A 5 minute `maxAge` means one refresh per browser tab, not one RPC per navigation. That keeps the Auth DO off the hot path.

Revoked sessions stay valid until `maxAge`. Use `disableCookieCache: true` on sensitive actions.

## Rules

- Construct `betterAuth()` only inside `AuthStore`
- Import `better-auth/minimal` and `better-auth-drizzle-adapter`
- Enable `cookieCache` with `strategy: 'compact'`
- Pick the DO with a key the request already has. Never list or scan DOs
- Serialize Request fields for `handleAuth`. Do not RPC the live Request
- Forward `setCookies` after every `lookupSession` miss
- Pass `isSecure` from `request.url` into `getCookieCache`
