---
name: better-auth
description: >
  Authentication and authorization with better-auth in Spiceflow and TypeScript apps.
  Covers server config with Drizzle adapter (Postgres and SQLite), Spiceflow middleware
  for forwarding auth requests, client setup, session middleware, social and email/password
  auth, server-side session checks, and React client hooks (useSession, signIn, signOut,
  signUp). ALWAYS load this skill when a project uses better-auth.
---

# better-auth

better-auth is the most comprehensive authentication framework for TypeScript. It provides email/password, social OAuth, session management, 2FA, and more out of the box. It works with any backend that uses standard Request/Response objects.

Full docs: https://better-auth.com/llms.txt

## URL construction

Always use `new URL(path, base)` instead of string concatenation or template literals for building URLs:

```ts
// GOOD
const url = new URL('/api/auth', process.env.BETTER_AUTH_URL)

// BAD
const url = `${process.env.BETTER_AUTH_URL}/api/auth`
const url = process.env.BETTER_AUTH_URL + '/api/auth'
```

`new URL` handles trailing slashes, normalizes paths, and avoids double-slash bugs.

## Installation

With drizzle-orm v0 (stable):

```bash
pnpm add better-auth @better-auth/drizzle-adapter
```

With drizzle-orm v1 (beta) — requires the PR #6913 build:

```bash
pnpm add better-auth @better-auth/drizzle-adapter@"https://pkg.pr.new/better-auth/better-auth/@better-auth/drizzle-adapter@6913"
pnpm add drizzle-orm@beta
```

## Server config

Create `src/lib/auth.ts` (or `lib/auth.ts`). Export the auth instance as `auth`.

### Drizzle adapter (Postgres)

```ts
// src/lib/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter' // or 'better-auth/adapters/drizzle' for v0
import { db } from 'db' // drizzle instance from your db workspace package
import * as schema from 'db/schema' // your drizzle schema

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
    // pass schema if your table names differ from better-auth defaults:
    // schema: { ...schema, user: schema.users },
    // or use usePlural: true if all tables are plural
  }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  // enable experimental joins for 2-3x perf on getSession
  experimental: { joins: true },
})
```

### Drizzle adapter (SQLite)

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from 'db'
import * as schema from 'db/schema'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema,
  }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  emailAndPassword: { enabled: true },
})
```

### Environment variables

`BETTER_AUTH_URL` is **always a secret**, never a plain env var or hardcoded value. It differs per environment: dev uses `http://localhost:3000`, preview uses the preview deploy URL, production uses the real domain. Treat it the same as `BETTER_AUTH_SECRET`.

For Cloudflare Workers, put both in `secrets.required` in `wrangler.jsonc`:

```jsonc
{
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

For Doppler/Sigillo, set per-environment values:

| Variable | development | preview | production |
|---|---|---|---|
| `BETTER_AUTH_URL` | `http://localhost:3000` | `https://preview.example.com` | `https://example.com` |
| `BETTER_AUTH_SECRET` | (random 32+ chars) | (random 32+ chars) | (random 32+ chars) |

```env
BETTER_AUTH_SECRET=  # min 32 chars, generate with: openssl rand -base64 32
BETTER_AUTH_URL=     # MUST be set per env — never hardcode
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## Schema generation

better-auth manages its own tables (`user`, `session`, `account`, `verification`). Generate the Drizzle schema for them:

```bash
pnpm dlx auth@latest generate
```

This outputs a Drizzle schema file. Add the generated tables to your `src/schema.ts` and run `drizzle-kit generate` + `drizzle-kit migrate` as usual.

When you add plugins that require new tables (2FA, organization, etc.), re-run `pnpm dlx auth@latest generate` to update the schema.

## Spiceflow integration

### Auth route middleware

In Spiceflow, mount better-auth using a `.use()` middleware that forwards requests with the `/api/auth` prefix to `auth.handler()`. If auth returns a 404 (no matching auth endpoint), fall through to your own routes instead of returning the 404:

```ts
import { Spiceflow } from 'spiceflow'
import { auth } from './lib/auth'

export const app = new Spiceflow()
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const response = await auth.handler(request)
      // if better-auth doesn't handle this path, fall through to app routes
      if (response.status === 404) {
        return next()
      }
      return response
    }
    return next()
  })
  // ... rest of your routes
```

This handles ALL better-auth endpoints (sign-in, sign-up, OAuth callback, session, etc.). The middleware short-circuits for auth paths and returns the auth response directly. Non-auth paths and unmatched auth paths fall through to `next()`.

### Session state + loader

Use `.state()` to resolve the session once in middleware, then expose it to all pages and client components via a `/*` loader. This is the recommended pattern — it's fully type-safe and avoids prop drilling:

```ts
import { Spiceflow, redirect } from 'spiceflow'
import { auth } from './lib/auth'

// Session type — includes both session and user, with plugin-extended fields
type AuthSession = typeof auth.$Infer.Session | null

export const app = new Spiceflow()
  // 1. Auth middleware — forward /api/auth/* to better-auth
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const response = await auth.handler(request)
      if (response.status === 404) return next()
      return response
    }
    return next()
  })

  // 2. Session state — resolved once per request via middleware
  .state('session', null as AuthSession)
  .use(async ({ request, state }) => {
    state.session = await auth.api.getSession({ headers: request.headers })
  })

  // 3. Session loader — exposes session to all pages and client components
  // Matched by every page/layout via wildcard. Loader data is merged,
  // so pages can add their own loaders and session is always available.
  .loader('/*', ({ state }) => {
    return { session: state.session }
  })
```

This runs on every request including landing pages — that's fine. When no session cookie is present, `getSession` just parses the cookie header and returns `null` immediately. No database query, no crypto, no async work. It's as cheap as a `Map.get()` call.

Now **every page, layout, and client component** can access the session type-safely:

**In server components (pages/layouts)** — via `loaderData`:

```tsx
.layout('/*', async ({ loaderData, children }) => {
  return (
    <html>
      <body>
        {loaderData.session && <nav>{loaderData.session.user.name}</nav>}
        {children}
      </body>
    </html>
  )
})

.page('/dashboard', async ({ loaderData }) => {
  if (!loaderData.session) return redirect('/login')
  return <Dashboard user={loaderData.session.user} />
})
```

**In client components** — via `useLoaderData` hook from `spiceflow/react`:

```tsx
'use client'

import { useLoaderData } from 'spiceflow/react'

export function UserMenu() {
  // Type-safe when SpiceflowRegister is declared in the app entry file
  const { session } = useLoaderData('/*')

  if (!session) return <a href="/login">Sign in</a>

  return (
    <div>
      <span>{session.user.name}</span>
      <a href="/api/auth/sign-out">Sign out</a>
    </div>
  )
}
```

The `/*` loader matches all pages, so `session` is always available in `useLoaderData`. When multiple loaders match (e.g. `/*` and `/dashboard`), their return values are merged into a single flat object — more specific loaders override less specific ones on key conflicts.

### Protecting API routes

For API routes (not pages), use `state.session` directly since loaders only run for pages:

```ts
.route({
  method: 'POST',
  path: '/api/posts',
  request: z.object({
    title: z.string(),
    content: z.string(),
  }),
  async handler({ request, state }) {
    if (!state.session) {
      return new Response('Unauthorized', { status: 401 })
    }
    const body = await request.json()
    // use state.session.user.id or state.session.session.userId
    return { id: '1', authorId: state.session.user.id }
  },
})
```

### Full Spiceflow app example

```ts
import { Spiceflow, redirect } from 'spiceflow'
import { auth } from './lib/auth'
import { z } from 'zod'

type AuthSession = typeof auth.$Infer.Session | null

export const app = new Spiceflow()
  // Auth middleware
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const response = await auth.handler(request)
      if (response.status === 404) return next()
      return response
    }
    return next()
  })
  // Session state
  .state('session', null as AuthSession)
  .use(async ({ request, state }) => {
    state.session = await auth.api.getSession({ headers: request.headers })
  })
  // Session loader — available to all pages and client components
  .loader('/*', ({ state }) => {
    return { session: state.session }
  })
  // Pages
  .page('/login', async ({ loaderData }) => {
    if (loaderData.session) return redirect('/')
    const { LoginButton } = await import('./components/login-button')
    return <LoginButton />
  })
  .page('/dashboard', async ({ loaderData }) => {
    if (!loaderData.session) return redirect('/login')
    return <div>Hello, {loaderData.session.user.name}</div>
  })
  // API routes use state.session directly
  .get('/api/me', ({ state }) => {
    if (!state.session) return new Response('Unauthorized', { status: 401 })
    return state.session.user
  })

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
```

## Client setup

### React client

```ts
// src/lib/auth-client.ts
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  // omit baseURL if client and server share the same domain
  baseURL: process.env.NEXT_PUBLIC_URL,
})

export const { signIn, signUp, signOut, useSession } = authClient
```

### With plugins

```ts
import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_URL,
  plugins: [
    twoFactorClient({
      twoFactorPage: '/two-factor',
    }),
  ],
})

export const { signIn, signUp, signOut, useSession } = authClient
```

### Vanilla client (non-React)

```ts
import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient({
  
})
```

## Client usage patterns

### useSession — reactive session in components

This is discouraged. Prefer passing down session via spiceflow loaders or props instead.

```tsx
import { useSession } from '@/lib/auth-client'

function UserProfile() {
  const { data: session, isPending, error } = useSession()

  if (isPending) return <div>Loading...</div>
  if (!session) return <div>Not signed in</div>

  return <div>Hello, {session.user.name}</div>
}
```

### Sign in with email/password

```ts
import { signIn } from '@/lib/auth-client'

await signIn.email(
  {
    email: 'user@example.com',
    password: 'password123',
    callbackURL: '/dashboard',
    rememberMe: true,
  },
  {
    onRequest: () => setLoading(true),
    onResponse: () => setLoading(false),
    onError: (ctx) => toast.error(ctx.error.message),
  },
)
```

### Sign in with social provider (Google)

```ts
import { signIn } from '@/lib/auth-client'

await signIn.social({
  provider: 'google',
  callbackURL: '/dashboard',
})
```

### Sign up

```ts
import { signUp } from '@/lib/auth-client'

await signUp.email({
  email: 'user@example.com',
  password: 'password123',
  name: 'John Doe',
  image: '', // optional, base64 or URL
  callbackURL: '/dashboard',
  fetchOptions: {
    onRequest: () => setLoading(true),
    onResponse: () => setLoading(false),
    onError: (ctx) => toast.error(ctx.error.message),
  },
})
```

### Sign out

```ts
import { signOut } from '@/lib/auth-client'

await signOut({
  fetchOptions: {
    onSuccess: () => router.push('/login'),
  },
})
```

### Using with Spiceflow typed fetch client

When calling authenticated Spiceflow API routes from the client, use `createSpiceflowFetch` with `credentials: 'include'` so cookies are sent:

```ts
import { createSpiceflowFetch } from 'spiceflow/client'

// Type safety comes from SpiceflowRegister declared in the app entry file
const safeFetch = createSpiceflowFetch(new URL('/', process.env.NEXT_PUBLIC_URL!).href)

const me = await safeFetch('/api/me', {
  fetch: { credentials: 'include' },
})
if (me instanceof Error) {
  console.error(me.message)
  return
}
console.log(me.name, me.email) // fully typed from the route handler return type
```

## Server-side session checks

With the `/*` loader pattern above, session is already available in `loaderData` for all pages. For standalone server code that needs a session outside of Spiceflow (scripts, cron jobs, etc.):

```ts
import { auth } from './lib/auth'

const session = await auth.api.getSession({
  headers: request.headers,
})
if (!session) {
  // handle unauthenticated
}
```

## Session caching

Enable cookie caching to avoid hitting the database on every `getSession` call:

```ts
export const auth = betterAuth({
  // ...
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh expiry every 1 day
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
      strategy: 'compact', // smallest size, signed, default
      // 'jwt' for JWT compatibility
      // 'jwe' for full encryption
    },
  },
})
```

To bypass the cache for sensitive operations:

```ts
const session = await auth.api.getSession({
  headers: request.headers,
  query: { disableCookieCache: true },
})
```

## Plugins

better-auth has a plugin system for adding features. Common plugins:

### Two-factor authentication

**Server:**
```ts
import { betterAuth } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'

export const auth = betterAuth({
  // ...
  plugins: [twoFactor()],
})
```

**Client:**
```ts
import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [twoFactorClient({ twoFactorPage: '/two-factor' })],
})
```

After adding plugins, re-run `pnpm dlx auth@latest generate` to generate updated schema, then run drizzle migrations.

### Other plugins

- **organization** — multi-tenant orgs with roles and teams
- **passkey** — WebAuthn/passkey authentication
- **magic-link** — passwordless email links
- **email-otp** — one-time password via email
- **username** — username-based auth
- **admin** — admin panel and user management
- **bearer** — Bearer token auth for APIs
- **api-key** — API key authentication

See https://better-auth.com/llms.txt for full plugin docs.

## Spiceflow page examples

### Login page

A standalone login page that redirects to the dashboard if already authenticated. Uses `loaderData.session` from the `/*` loader — no need to call `getSession` again:

```tsx
// In your app entry (src/main.tsx or src/app.tsx)
// Assumes auth middleware + session state + /* loader are registered (see above)

  .page('/login', async ({ loaderData }) => {
    if (loaderData.session) return redirect('/')
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <h1 className="text-2xl font-bold tracking-tight mb-2">My App</h1>
          <p className="text-muted-foreground mb-6">Sign in to continue</p>
          <LoginButton />
        </div>
      </div>
    )
  })
```

```tsx
// src/components/login-button.tsx
'use client'

import { useState } from 'react'
import { authClient } from '../lib/auth-client'

export function LoginButton() {
  const [loading, setLoading] = useState(false)

  return (
    <button
      onClick={async () => {
        setLoading(true)
        await authClient.signIn.social({
          provider: 'google',
          callbackURL: '/',
        })
      }}
      disabled={loading}
      className="h-10 px-6 rounded-lg bg-primary text-primary-foreground font-semibold"
    >
      {loading ? 'Redirecting...' : 'Sign in with Google'}
    </button>
  )
}
```

### Root redirect for authenticated users

```ts
.get('/', async ({ state }) => {
  if (!state.session) return redirect('/login')
  return redirect('/dashboard')
})
```

### Protected layout with session

Use a layout to enforce auth for a group of pages. The session is available from `loaderData` (provided by the `/*` loader), so the layout just checks it and renders:

```tsx
.layout('/app/*', async ({ loaderData, children }) => {
  if (!loaderData.session) return redirect('/login')
  const { user } = loaderData.session

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r p-4">
        <div className="text-sm text-muted-foreground">{user.email}</div>
        <nav>{/* sidebar links */}</nav>
        <a href="/api/auth/sign-out" className="text-sm text-muted-foreground mt-auto">
          Sign out
        </a>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
})
```

### Protected page

Pages under a protected layout don't need to re-check auth — the layout already redirected unauthenticated users. Session data is still available via `loaderData`:

```tsx
.page('/app/settings', async ({ loaderData }) => {
  const { user } = loaderData.session!
  return (
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p>Signed in as {user.name} ({user.email})</p>
    </div>
  )
})
```

### Protected API route

API routes don't use loaders — use `state.session` directly:

```ts
.route({
  method: 'POST',
  path: '/api/posts',
  request: z.object({
    title: z.string().min(1),
    content: z.string(),
  }),
  async handler({ request, state }) {
    if (!state.session) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = await request.json()
    const post = await createPost({ ...body, authorId: state.session.user.id })
    return { ok: true, id: post.id }
  },
})
```

### Sign out link

For server-rendered apps, link directly to the BetterAuth sign-out endpoint:

```tsx
<a href="/api/auth/sign-out">Sign out</a>
```

Or use the client method for SPA-style sign-out with a redirect:

```tsx
'use client'
import { authClient } from '../lib/auth-client'

function SignOutButton() {
  return (
    <button onClick={() => authClient.signOut({
      fetchOptions: { onSuccess: () => window.location.href = '/login' },
    })}>
      Sign out
    </button>
  )
}
```

### Reading session in any client component

Any client component can read the session via `useLoaderData` without props — it's type-safe and always available from the `/*` loader:

```tsx
'use client'
import { useLoaderData } from 'spiceflow/react'

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { session } = useLoaderData('/*')

  if (!session) return <a href="/login">Please sign in</a>
  return <>{children}</>
}
```

## Drizzle ORM v1 (beta) compatibility

The official `@better-auth/drizzle-adapter` on npm targets `drizzle-orm` v0.x and does **not** work with `drizzle-orm@beta` (v1.0.0-beta). The adapter relies on v0 APIs (`db._.fullSchema`, `db.query`) that changed in v1 — you get errors like `"model 'user' was not found in the schema object"`.

**To use drizzle-orm@beta (v1)**, install the adapter from PR #6913 which adds v1 support:

```bash
pnpm add @better-auth/drizzle-adapter@"https://pkg.pr.new/better-auth/better-auth/@better-auth/drizzle-adapter@6913"
pnpm add drizzle-orm@beta
```

This is a pre-release build from https://github.com/better-auth/better-auth/pull/6913 — it works but is not yet merged into better-auth main. Track progress at https://github.com/better-auth/better-auth/issues/6766.

Once the PR is merged, switch back to `pnpm add @better-auth/drizzle-adapter@latest`.

Usage is the same as the stable adapter:

```ts
import { drizzleAdapter } from '@better-auth/drizzle-adapter'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg', // or 'sqlite'
    schema, // pass your drizzle schema
  }),
  // ...
})
```

## Server-side API calls and cookies

When calling `auth.api.*` methods server-side (e.g. `auth.api.signInSocial()`), the response cookies (state cookies, session cookies) are **not automatically sent to the browser**. If you extract just the URL and create your own `Response.redirect()`, all `Set-Cookie` headers are lost.

This causes `state_mismatch` errors on OAuth callbacks because BetterAuth stores a signed state cookie for CSRF protection. Without it, the callback validation fails.

**Always use `returnHeaders: true`** and manually forward cookies when the result is a browser redirect:

```ts
// BAD — cookies lost, causes state_mismatch on callback
.get('/sign-in', async ({ request }) => {
  const auth = getAuth()
  const res = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL: request.url },
  })
  return Response.redirect(res.url, 302) // ← bare redirect, no cookies!
})

// GOOD — returnHeaders + manual cookie forwarding
.get('/sign-in', async ({ request }) => {
  const auth = getAuth()
  // signInSocial returns JSON { url, redirect } on server calls.
  // Use returnHeaders to get both the parsed body AND Set-Cookie headers.
  const { response: result, headers } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL: request.url },
    headers: request.headers,
    returnHeaders: true,
  })
  if (!result?.url) {
    return new Response('Failed to initiate sign-in', { status: 500 })
  }
  const redirect = new Response(null, { status: 302, headers: { Location: result.url } })
  for (const cookie of headers.getSetCookie()) {
    redirect.headers.append('Set-Cookie', cookie)
  }
  return redirect
})
```

**Do NOT use `asResponse: true`** for `signInSocial` — it returns a JSON Response with `{ url, redirect: true }` body, not a 302 redirect. The redirect is client-side behavior. On the server you must build the redirect yourself.

**When to use each pattern:**

- **`returnHeaders: true`** — when you need Set-Cookie headers from the response (OAuth redirects, sign-in flows that set state cookies). Returns `{ headers, response }` where `response` is the parsed body and `headers` is a `Headers` object with `getSetCookie()`.
- **`asResponse: true`** — when you want the raw `Response` object (rarely useful for `signInSocial` since it returns JSON, not a redirect).
- **Default (no flag)** — when you just need the data (e.g. `getSession`). Returns the parsed body directly. Cookies are not forwarded.

**`headers` parameter** — always pass the original `request.headers` when the API call needs request context (cookies, user agent, IP). Without it, BetterAuth can't read existing cookies or set new ones with the correct domain.

## SQLite/D1 date binding issue

BetterAuth passes `Date` objects for timestamp columns (`createdAt`, `updatedAt`, `expiresAt`). This crashes on Cloudflare D1 because D1's `.bind()` only accepts `string | number | null | ArrayBuffer`.

**Do not use `new Proxy` to wrap D1.** Instead, use a drizzle `customType` called `epochMs` for all timestamp columns. It stores epoch milliseconds as integers (same SQL type, no migration needed) but converts `Date → date.getTime()` in drizzle's `toDriver` hook before values reach D1. See the `drizzle` skill's "Timestamps" section for the full implementation.

```ts
// Use epochMs instead of integer({ mode: 'number' }) for timestamps
const user = sqliteTable('user', {
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

// Then pass env.DB directly to drizzle, no wrapper needed
export function getDb() {
  return drizzle(env.DB, { schema, relations: schema.relations })
}
```

**Why not `supportsDates: false`?** When this flag is set, BetterAuth converts `Date → toISOString()` (a string). If your columns are `integer` (storing epoch ms), this stores ISO strings in integer columns, corrupting data and breaking sorting/comparisons.

**Why not `integer({ mode: 'timestamp_ms' })`?** This changes the TypeScript type from `number` to `Date`, requiring changes across the entire codebase. API JSON responses would serialize as ISO strings instead of epoch numbers, breaking CLI clients.

This issue is tracked in https://github.com/better-auth/better-auth/issues/8882 (PR #8913 adds `supportsDates: false` for SQLite but converts to ISO strings, not epoch numbers, so it doesn't help for integer timestamp schemas).

## Cloudflare Workers

better-auth uses AsyncLocalStorage. Enable it in `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

Or for just AsyncLocalStorage: `["nodejs_als"]`.

## Social providers

### Google

Always set `prompt: 'select_account'` so Google shows the account picker every time. Without it, users with a single Google session are silently signed in with no way to switch accounts.

```ts
socialProviders: {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    prompt: 'select_account', // always show account picker
  },
}
```

### GitHub

```ts
socialProviders: {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  },
}
```


Multiple providers can be enabled simultaneously. Each provider needs its own OAuth app credentials.

## Core schema

better-auth creates and manages these tables:

- **user** — id, name, email, emailVerified, image, createdAt, updatedAt
- **session** — id, token, userId, expiresAt, ipAddress, userAgent, createdAt, updatedAt
- **account** — id, userId, accountId, providerId, accessToken, refreshToken, expiresAt, etc.
- **verification** — id, identifier, value, expiresAt, createdAt, updatedAt

Generate the Drizzle schema for these with `pnpm dlx auth@latest generate`. Do not define these tables manually. Plugins add additional tables (e.g. `twoFactor` adds a `twoFactor` table).

## Table name customization

If your Drizzle schema uses different table names (e.g. `users` instead of `user`):

```ts

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      ...schema,
      user: schema.users, // map better-auth's "user" to your "users" table
    },
  }),
})
```

Or configure via `modelName`:

```ts
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  user: { modelName: 'users' },
  session: { modelName: 'sessions' },
})
```

Or if all tables are plural:

```ts
drizzleAdapter(db, {
  provider: 'pg',
  usePlural: true,
})
```
