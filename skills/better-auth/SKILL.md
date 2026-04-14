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

```env
BETTER_AUTH_SECRET=  # min 32 chars, generate with: openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3000
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

### Session middleware

Use `.state()` to store the full session object so downstream handlers can access it. The session type comes from better-auth:

```ts
import { Spiceflow } from 'spiceflow'
import { auth } from './lib/auth'
import type { Session } from 'better-auth/types'

type AuthSession = {
  session: Session
  user: {
    id: string
    email: string
    name: string
    image?: string | null
    emailVerified: boolean
    createdAt: Date
    updatedAt: Date
  }
} | null

export const app = new Spiceflow({ basePath: '/api' })
  .state('session', null as AuthSession)
  .use(async ({ request, state }) => {
    const sessionData = await auth.api.getSession({
      headers: request.headers,
    })
    state.session = sessionData
  })
  .get('/me', ({ state }) => {
    if (!state.session) {
      return new Response('Unauthorized', { status: 401 })
    }
    return state.session.user
  })
```

### Protecting routes

For routes that require auth, check `state.session` and throw/return early:

```ts
.post('/posts', async ({ request, state }) => {
  if (!state.session) {
    return new Response('Unauthorized', { status: 401 })
  }
  const userId = state.session.session.userId
  const body = await request.json()
  // ... create post
  return { id: '1', authorId: userId }
})
```

### Full Spiceflow app example

```ts
import { Spiceflow } from 'spiceflow'
import { auth } from './lib/auth'
import { z } from 'zod'

type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>

export const app = new Spiceflow()
  // 1. Auth middleware — forward /api/auth/* to better-auth
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const response = await auth.handler(request)
      if (response.status === 404) {
        return next()
      }
      return response
    }
    return next()
  })
  // 2. Session middleware — populate state for all routes
  .state('session', null as AuthSession)
  .use(async ({ request, state }) => {
    const sessionData = await auth.api.getSession({
      headers: request.headers,
    })
    state.session = sessionData
  })
  // 3. Your API routes
  .get('/api/me', ({ state }) => {
    if (!state.session) {
      return new Response('Unauthorized', { status: 401 })
    }
    return state.session.user
  })
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
      // create post with state.session.session.userId
      return { id: '1', title: body.title }
    },
  })
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
  baseURL: 'http://localhost:3000',
})
```

## Client usage patterns

### useSession — reactive session in components

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

### Using with Spiceflow typed client

When calling authenticated Spiceflow API routes from the client, pass `credentials: 'include'` so cookies are sent:

```ts
import { createSpiceflowClient } from 'spiceflow/client'
import type { App } from './server'

const client = createSpiceflowClient<App>('http://localhost:3000')

const me = await client.api.me.get({
  fetch: { credentials: 'include' },
})
```

## Server-side session checks

For server components, loaders, or any server code that needs the session without the middleware:

```ts
import { auth } from '@/lib/auth'

// In a Spiceflow loader or page handler
.loader('/*', async ({ request }) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  })
  if (!session) {
    throw redirect('/login')
  }
  return { user: session.user }
})
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

A standalone login page that redirects to the dashboard if already authenticated. The sign-in button is a client component that triggers the OAuth flow:

```tsx
// src/app.tsx
import { Spiceflow, redirect } from 'spiceflow'
import { auth } from './lib/auth'
import { LoginButton } from './components/login-button'

export const app = new Spiceflow()
  // ... auth middleware (see above) ...

  .page('/login', async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (session) return redirect('/')
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

### Auth helpers for pages vs API routes

Define two helper functions: one for pages (redirects to login) and one for API routes (returns 401 JSON):

```ts
import { redirect } from 'spiceflow'
import { auth } from './lib/auth'

async function requirePageSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) throw redirect('/login')
  return session
}

async function requireApiSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  return session
}
```

### Root redirect for authenticated users

```ts
.get('/', async ({ request }) => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return redirect('/login')
  // redirect to the user's default page
  return redirect('/dashboard')
})
```

### Protected layout with session

Use a layout to enforce auth for a group of pages. The session check happens once in the layout, and all child pages inherit it:

```tsx
.layout('/app/*', async ({ children, request }) => {
  const session = await requirePageSession(request)

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r p-4">
        <div className="text-sm text-muted-foreground">{session.user.email}</div>
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

Pages under a protected layout don't need to re-check auth — the layout already did it. But if you need the session data in the page handler, call `requirePageSession` again (it's cheap if cookie caching is on):

```tsx
.page('/app/settings', async ({ request }) => {
  const session = await requirePageSession(request)
  return (
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p>Signed in as {session.user.name} ({session.user.email})</p>
    </div>
  )
})
```

### Protected API route

```ts
.route({
  method: 'POST',
  path: '/api/posts',
  request: z.object({
    title: z.string().min(1),
    content: z.string(),
  }),
  async handler({ request }) {
    const session = await requireApiSession(request)
    const body = await request.json()
    // use session.user.id, session.session.userId, etc.
    const post = await createPost({ ...body, authorId: session.user.id })
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

```ts
socialProviders: {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    // prompt: 'consent', // force consent screen
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

### Discord

```ts
socialProviders: {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
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
