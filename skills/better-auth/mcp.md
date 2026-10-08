# MCP OAuth with Better Auth

Use this when an app needs a **remote HTTP MCP** that Cursor, Claude, VS Code, or other MCP clients can add with OAuth. Do **not** use this for local stdio (`mycli mcp`). Stdio reuses the CLI session from `deviceAuthorization` + `bearer`.

Canonical docs (fetch in full, never truncate):

- https://better-auth.com/docs/plugins/mcp
- https://better-auth.com/docs/plugins/cimd
- https://better-auth.com/docs/plugins/oauth-provider
- https://better-auth.com/docs/plugins/jwt
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

Working examples: [ghosthand](https://github.com/remorses/ghosthand) (`website/src/cimd-fetch.ts`, `website/src/actions.tsx` consent, `website/wrangler.jsonc` flags), tested end to end on a deployed Worker. [Strada](https://github.com/remorses/strada) (`website/src/mcp.ts`, `website/src/db.ts`, `db/src/schema.ts`); its `cimd-fetch.ts` uses `connect()` and fails on Workers, see [CIMD on Workers](#cimd-on-workers).

```
MCP client (Cursor, Claude)
        │
        │  POST /mcp  →  401 + WWW-Authenticate
        ▼
  /.well-known/oauth-protected-resource
        │
        ▼
  /oauth2/authorize  ►  /login then /consent
        │
        ▼
  /oauth2/token  (PKCE, CIMD, resource-bound JWT)
        │
        ▼
  POST /mcp  behind requireMcpAuth
```

**Better Auth** owns login, consent, discovery, PKCE, tokens, and challenges. The MCP SDK owns JSON-RPC transport. Do not mix those jobs. Do not put OAuth on a stdio MCP server.

## When to add it

Add `@better-auth/mcp` only if users will connect with a URL like `https://example.com/mcp`.

Skip it when:

- MCP is **stdio** on a CLI binary (`createMcpAction` from `@goke/mcp`)
- The agent already logs in with `mycli login` (device flow) and the local process has a saved session

Local stdio + hosted HTTP can coexist. They use different auth.

| Surface | Auth |
| --- | --- |
| `mycli mcp` (stdio) | Saved session from `deviceAuthorization` + `bearer` |
| `https://example.com/mcp` | `@better-auth/mcp` OAuth 2.1 + CIMD |

Stdio uses the session cookie / bearer from device flow. HTTP MCP uses OAuth access tokens bound to the MCP **resource**. Never send the MCP JWT to `/api/v0` or other app APIs. Those APIs still use Better Auth sessions.

## Packages

Never import `mcp` from `better-auth/plugins`. That plugin is deprecated. The current package is `@better-auth/mcp` (1.7+), built on `@better-auth/oauth-provider`.

```bash
pnpm add @better-auth/mcp @better-auth/cimd @better-auth/oauth-provider
```

`jwt()` from `better-auth/plugins` is required. It signs access tokens and serves `/jwks`.

Do **not** also register `oauthProvider()`. `mcp()` is already the OAuth provider.

On Cloudflare Workers use `better-auth/minimal` and `better-auth-drizzle-adapter`.

For CLI reuse on Spiceflow / Workers, keep MCP SDK **v1** Streamable HTTP (`@modelcontextprotocol/sdk` + `WebStandardStreamableHTTPServerTransport`). Do not migrate transport to MCP SDK v2. CIMD `metadataProfile: 'mcp-2026-07-28'` is only client metadata.

## Auth config

```ts
import { betterAuth } from 'better-auth/minimal'
import { jwt, bearer, deviceAuthorization } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'

const MCP_RESOURCE = new URL('/mcp', env.BETTER_AUTH_URL).href

export const auth = betterAuth({
  disabledPaths: ['/token'],
  plugins: [
    deviceAuthorization({ verificationUri: '/device', schema: {} }),
    bearer(),
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      loginPage: '/login',
      consentPage: '/consent',
      resource: MCP_RESOURCE,
    }),
    cimd({
      fetchClientMetadataResource: fetchCimdOnWorkers,
      metadataProfile: 'mcp-2026-07-28',
    }),
  ],
})
```

On Node, pass `fetchClientMetadataResource` from `@better-auth/cimd/node`. On Workers, inject a `fetch`-based transport. See [CIMD on Workers](#cimd-on-workers).

`disabledPaths: ['/token']` hides the old JWT plugin token route. MCP uses `/oauth2/token`.

`jwt({ disableSettingJwtHeader: true })` stops Better Auth from putting a JWT on ordinary session responses. MCP tokens stay on `/mcp`.

### `resource`

- HTTPS. No query. No fragment. No userinfo.
- HTTP only on loopback.
- Same string for `mcp({ resource })` and `requireMcpAuth`.
- Build it from `BETTER_AUTH_URL`. Preview and prod must differ.

That value is the token `aud` and the RFC 9728 resource identifier.

`loginPage` and `consentPage` are required. The app must already have `/login`. Add `/consent` that calls `auth.api.oauth2Consent`.

Keep existing `deviceAuthorization` for `mycli login`. That flow issues a Better Auth session, not an MCP resource token.

Optional: `oauthDeviceAuthorization({ verificationUri: '/device' })` next to `mcp()` if a **registered public CLI** should get the same audience-bound MCP token without a local callback. That does not replace auth-code + PKCE for Cursor and Claude. Do not add it unless the CLI implements RFC 8628 against `/device/code` and `/oauth2/token`.

## Client plugin

Install `oauthProviderClient()` on the browser auth client.

```ts
import { createAuthClient } from 'better-auth/client'
import { deviceAuthorizationClient } from 'better-auth/client/plugins'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'

export const authClient = createAuthClient({
  plugins: [deviceAuthorizationClient(), oauthProviderClient()],
})
```

This plugin copies the signed `oauth_query` through Google login. After `/login`, Better Auth resumes `/oauth2/authorize` then `/consent`.

Do not rebuild `/api/auth/oauth2/authorize?...` as `callbackURL`. That duplicates Better Auth and skips signature checks on the query.

Keep `/consent` in the login safe-redirect allowlist. After Google, the user must return to `/consent`, not `/wip` or `/`.

## Schema

`cimd()` has no extra tables. It writes into the OAuth Provider tables.

After adding `jwt()` + `mcp()` + `cimd()`, generate schema:

```bash
pnpm dlx auth generate
```

Then write a D1/Postgres migration by hand. Do not invent columns. Do not invent `onDelete` actions.

Tables:

| Table | Role |
| --- | --- |
| `jwks` | signing keys for MCP access tokens |
| `oauthClient` | clients. CIMD sets `clientDiscoveryId` to `"cimd"` |
| `oauthResource` | MCP URL as `aud` |
| `oauthClientResource` | which client can request which resource |
| `oauthRefreshToken` | refresh tokens |
| `oauthAccessToken` | opaque tokens when there is no JWT audience |
| `oauthConsent` | user consent |
| `oauthClientAssertion` | `private_key_jwt` `jti` replay |

Official fields: https://github.com/better-auth/better-auth/blob/main/packages/oauth-provider/src/schema.ts

Prisma references with the 1.7 shape:

- https://github.com/elie222/inbox-zero/blob/main/apps/web/prisma/schema.prisma
- https://github.com/OtaKit/otakit/blob/main/packages/console/prisma/schema.prisma

Existing `deviceCode` tables for CLI login stay. Do not replace device flow with MCP OAuth.

### D1 traps

**`clientId` is a URL.** CIMD ids look like `https://cursor.com/.well-known/oauth-client`. Do not use ULID-only columns.

**`clientDiscoveryId` is nullable.** `"cimd"` means CIMD owns the row. `NULL` means admin or DCR created it. Never set it by inspecting whether `clientId` starts with `https://`.

**SQLite arrays.** `better-auth-drizzle-adapter` with `supportsArrays: true` binds `string[]` as extra SQL params. D1 rejects the insert. Use JSON text. SQL stays `TEXT`.

```ts
scopes: s.text('scopes', { mode: 'json' }).$type<string[]>(),
redirectUris: s.text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
grantTypes: s.text('grant_types', { mode: 'json' }).$type<string[]>(),
metadata: s.text('metadata', { mode: 'json' }),
```

**Dates.** Better Auth fields are `type: "date"`. Use `integer({ mode: 'timestamp_ms' })` on `user`, `session`, `account`, `verification`, `jwks`, `deviceCode`, and OAuth tables. Cookie cache is `z.date()`. Do not use `epochMs` (number) on those columns. Do not disable `cookieCache`.

**Copy OAuth `onDelete` from Better Auth.** Official source: https://github.com/better-auth/better-auth/blob/main/packages/oauth-provider/src/schema.ts. Missing `onDelete` means **NO ACTION**. Do not add CASCADE to “make user delete work”.

```
user
  ├── oauth_client.user_id              NO ACTION, often NULL
  ├── oauth_refresh_token.user_id       NO ACTION
  ├── oauth_access_token.user_id        NO ACTION
  └── oauth_consent.user_id             NO ACTION

oauth_client.client_id
  ├── oauth_client_resource.client_id   CASCADE
  ├── oauth_refresh_token.client_id     NO ACTION
  ├── oauth_access_token.client_id      NO ACTION
  └── oauth_consent.client_id           NO ACTION
```

`oauthClient.userId` is optional. A CIMD MCP client is **one shared row** (`client_id` is the metadata URL, `user_id` is often `NULL`). Every user who consents gets tokens that point at that same `client_id`.

CASCADE on `oauth_client.user_id` deletes the client when that user goes. Token rows still hold `client_id` with **NO ACTION**, so SQLite rejects the delete. CASCADE on token `client_id` would delete **every** user’s tokens for that shared CIMD client.

Keep NO ACTION on `oauth_client.user_id` and on token/consent `client_id`. `oauth_client_resource.client_id` CASCADE is official (linkage only). Token `user_id` CASCADE is possible if you want user-delete to drop that user’s grants. Better Auth does not do it.

If a migration already shipped CASCADE on `oauth_client.user_id`, rebuild the FK in a follow-up. SQLite cannot `ALTER TABLE ... ADD CONSTRAINT`. Recreate the table. D1 splits on `;`, so `PRAGMA foreign_keys=OFF` does not cover later statements. Copy child rows to tables without FKs, drop children, replace `oauth_client`, restore children.

## Spiceflow routes

Forward these to `auth.handler`. Fall through only on 404. Return 401 and 403 from auth as-is.

```ts
.use(async ({ request }, next) => {
  const path = request.parsedUrl.pathname
  const isAuthPath = path.startsWith('/api/auth')
    || path.startsWith('/.well-known/oauth-authorization-server')
    || path.startsWith('/.well-known/oauth-protected-resource')
    || path.startsWith('/.well-known/openid-configuration')
  if (isAuthPath) {
    const response = await auth.handler(request)
    if (response.ok || response.status !== 404) return response
  }
  return next()
})
```

OAuth discovery and `/oauth2/*` live under `/api/auth`. Also make sure issuer well-known URLs reach the handler:

- `{issuer}/.well-known/oauth-authorization-server`
- `/.well-known/oauth-authorization-server/[issuer-path]`
- `/.well-known/oauth-protected-resource`

If Holocron or the app 404s those paths, add routes that call `auth.handler`.

Mount MCP next to the API, not under `/api/auth`.

```ts
app.route({
  method: '*',
  path: '/mcp',
  handler: ({ request }) => handleMcpRequest(request),
})
```

Inside the handler:

- Present disallowed `Origin` → **403**. Missing `Origin` is OK for native MCP clients.
- Not POST → **405** with `Allow: POST`.
- Then `requireMcpAuth(auth, handler, { resource })`.

Serve `GET /.well-known/oauth-client` as **Worker JSON**. A static file often has no `Content-Type`. CIMD then rejects it (`Metadata document must be JSON (got Content-Type none)`).

```ts
.get('/.well-known/oauth-client', () => Response.json(mcpClientMetadataDocument()))
```

That document is for **your** native preview client. Cursor and Claude bring their own `client_id` URLs. Preview loopback `redirect_uris` (`http://127.0.0.1:8765/callback`) are valid for that native public client (`token_endpoint_auth_method: 'none'`).

## CIMD

**CIMD** (Client ID Metadata Document) is how MCP clients identify themselves without Dynamic Client Registration. The client's `client_id` is an HTTPS URL that hosts JSON metadata (`client_name`, `redirect_uris`, keys). Better Auth fetches that URL and stores the client in `oauthClient` with `clientDiscoveryId: "cimd"`.

MCP 2026-07-28 deprecates DCR. Always add `cimd()` with `metadataProfile: "mcp-2026-07-28"`. Do not enable `allowDynamicClientRegistration` unless you must support old clients.

`fetchClientMetadataResource` is required. `@better-auth/cimd/node` is **Node only**. It resolves DNS once, rejects private IPs, pins the address, and refuses redirects.

### CIMD on Workers

Do **not** use `@better-auth/cimd/node` on Workers, Bun, or Deno.

Do **not** use `connect()` from `cloudflare:sockets` with a pinned IP (Strada's `cimd-fetch.ts`). **Workers TCP sockets cannot reach Cloudflare IP ranges**, and most MCP clients host their metadata behind Cloudflare (claude.ai, trycloudflare tunnels). Authorize then fails with `invalid_client: Failed to fetch metadata document (network error or redirect blocked)`, and nothing is logged. It works in `wrangler dev`, so only a deployed test finds it. https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

Use plain `fetch`. On Workers the network boundary already pins: subrequests leave from Cloudflare's edge, which has no private network and refuses special-use addresses. The transport must still:

1. Accept only HTTPS, and only GET or HEAD
2. Send `redirect: 'manual'` and throw on any 3xx
3. Cap the body at 64 KiB while reading the stream
4. Drop `content-encoding` and `content-length` from the returned headers (the body is decoded)

```ts
const MAX_BODY_BYTES = 64 * 1024

export async function fetchCimdOnWorkers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, { ...init, redirect: 'manual' })
  if (new URL(request.url).protocol !== 'https:') throw new TypeError('CIMD metadata URL must be HTTPS')
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new TypeError('CIMD transport supports only GET and HEAD')
  const response = await fetch(request)
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new TypeError('CIMD metadata redirects are not followed')
  }
  if (request.method === 'HEAD' || !response.body) return new Response(null, { status: response.status, headers: response.headers })
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new TypeError('CIMD response exceeded 64 KiB')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(body, { status: response.status, headers })
}
```

Working file: ghosthand `website/src/cimd-fetch.ts` (remorses/ghosthand).

## Consent page

The user must be signed in first. Redirect to `/login?callbackURL=/consent?...` if not.

Call `auth.api.oauth2Consent` with the request headers **and the request**, plus `asResponse: false`. Map `{ url }` to a redirect. Do not call `auth.handler()` from a server action and rewrite `Content-Type`. That can keep stale multipart `Content-Length`.

```ts
const request = getActionRequest()
const { url } = await auth.api.oauth2Consent({
  body: { accept, oauth_query: oauthQuery || undefined },
  headers: request.headers,
  // Accept resumes /oauth2/authorize, which throws 401 "request not found" without it.
  request,
  // With `request`, better-call returns a Response unless this is false.
  asResponse: false,
})
throw redirect(url)
```

Both traps show only when **Allow** is clicked: headers-only fails with `{"error":"invalid_request","error_description":"request not found"}`, and `request` without `asResponse: false` gives `url === undefined`, so the page silently re-renders. Click Allow in a real browser before shipping.

Show at least:

- client id
- scopes
- resource
- redirect URI

Generic "Allow access" is not enough. The user must see which CIMD client is asking.

## Protect POST /mcp

`requireMcpAuth` checks the `Authorization` header against JWKS (issuer, audience, expiry, DPoP when bound).

**On Workers, add the `global_fetch_strictly_public` compatibility flag.** `requireMcpAuth` downloads `{baseURL}/jwks` with `fetch`, and a Worker on a custom domain cannot fetch its own hostname without it. Every MCP call then throws `Jwks failed: <none>` (500, error 1101) after a successful token exchange. `wrangler dev` does not show it. The keys are cached in the isolate for 5 minutes, so the extra request is rare. Unauthenticated calls get JSON-RPC **401** plus RFC 9728 `WWW-Authenticate`. Missing scopes get **403** `insufficient_scope` so the client can step up.

If the MCP server is a different origin than Better Auth, use `createMcpProtectedRequestHandler` with explicit `issuer`, `audience`, and `jwksUrl`.

### Next.js-style POST (Better Auth docs)

MCP 2026-07-28 docs show a stateless HTTP `POST` with MCP SDK v2. Use that when the app is a Next.js route and tools are registered on `McpServer` directly.

```ts
import { requireMcpAuth } from '@better-auth/mcp'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

const MCP_RESOURCE = 'https://example.com/mcp'

const mcpServerHandler = createMcpHandler(
  () => {
    const server = new McpServer({ name: 'example', version: '1.0.0' })
    server.registerTool(
      'ping',
      { description: 'Health check', inputSchema: z.object({}) },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    )
    return server
  },
  { legacy: 'reject' },
)

export const POST = requireMcpAuth(
  auth,
  (request) => mcpServerHandler.fetch(request),
  { resource: MCP_RESOURCE },
)
```

Export only `POST`. Reject legacy session protocol.

### Spiceflow + goke CLI reuse (Workers)

Do not rewrite `issues_list` as website-only handlers. Reuse the goke command tree.

This is MCP SDK **v1** Streamable HTTP (protocol through `2025-11-25`). It is not the later `2026-07-28` JSON-RPC that drops `initialize`. Session IDs are optional in `2025-11-25`. Stateless servers omit them.

```ts
import { requireMcpAuth } from '@better-auth/mcp'
import { addCliToolsToMcp } from '@goke/mcp'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

export async function handleMcpRequest(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin && !isAllowedMcpOrigin(origin)) {
    return new Response(null, { status: 403 })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  return requireMcpAuth(
    auth,
    async (authenticatedRequest, accessTokenClaims) => {
      const sub = accessTokenClaims.sub
      if (typeof sub !== 'string' || sub.length === 0) {
        return new Response('unauthorized', { status: 401 })
      }
      return handleAuthenticatedMcp(authenticatedRequest, sub)
    },
    { resource: mcpResourceUrl() },
  )(request)
}
```

Per authenticated POST:

```
requireMcpAuth  ►  load user by sub
        │
        ▼
cli.clone({ cwd, env })
        │
        ▼
fresh Server + transport
sessionIdGenerator: undefined
        │
        ▼
addCliToolsToMcp  ►  handleRequest  ►  close both
```

Rules:

- `sessionIdGenerator: undefined`
- No `Map` of sessions
- Fresh `Server` + transport per POST
- Close both after the response
- Split a **command tree without TUI**. Workers cannot import termcast or bun spawn
- Exclude `login`, `logout`, `mcp`, `database create`, long-running Clack commands, completions
- Commands must use **`ctx`**. `node:fs`, `process.cwd()`, `process.env` at module load, and `process.exit` bypass isolation

Goke clone recipe: [goke mcp README](https://github.com/remorses/goke/blob/main/mcp/README.md) under **Multi-tenant remote MCP over HTTP**. Goke does not do OAuth. Wrap `requireMcpAuth` around that handler. Do not use `x-tenant-id` as login.

Remote MCP has **no folder**. Stdio uses `mycli setup` and `~/.app`. HTTP has no cwd. Tools that need a project must take `--project`. Keep those flags optional in MCP schema unless you chain `.required()`. `<value>` means "needs a value if present". It does not mean MCP `required`.

## Identity into /api/v0

The MCP JWT `aud` is `/mcp`. `/api/v0` must not accept it.

After `requireMcpAuth`:

1. Load the user by `sub`
2. Strip `Authorization` on in-process fetch to the app API
3. Pass a verified principal into that in-process call

```ts
headers.delete('authorization')
return api.handle(new Request(url, { method: request.method, headers, body: request.body }))
```

Do not mint a dummy `"mcp"` bearer token to satisfy `getApiClient()`.

`AsyncLocalStorage` can hold `{ userId, user, fetch }` for the request. Prefer an explicit principal on the in-process API. If `getSession` reads ALS first, every function inside that run is already a user. Keep the blast radius small. Scope `run()` to the transport `handleRequest` only.

## Tests

Never mock modules. Mint a real JWT when you test tools.

Minimum:

- POST `/mcp` no token → 401 + `WWW-Authenticate`
- GET `/mcp` → 405 with `Allow: POST`
- Present disallowed `Origin` → 403
- Same-origin CIMD JSON has `Content-Type: application/json`
- Consent uses `auth.api.oauth2Consent`
- Authenticated `tools/list` includes the query tools and excludes `login` and `mcp`
- Org A token cannot read org B

A test that only constructs `Response.json()` does not cover `GET /.well-known/oauth-client`. Call the real route.

### End-to-end with MCP Inspector

Unit tests miss Workers-only failures (CIMD sockets, JWKS self-fetch, consent action). Deploy to preview and run the real flow once with [MCP Inspector](https://github.com/modelcontextprotocol/inspector) v2 and playwriter:

1. `npx -y @modelcontextprotocol/inspector@latest`, add the server as `streamable-http` with the preview `/mcp` URL.
2. **Turn on CIMD** in Client settings > OAuth Client ID Metadata Document. Without it the Inspector tries DCR, which `mcp()` does not enable, and the server only shows "Failed".
3. The metadata URL must be public HTTPS and list `http://127.0.0.1:6274/oauth/callback`. Serve it from a small Bun server behind `cloudflared tunnel --url http://localhost:8790`, with `client_id` built from the request's `Host` header and path, and `Content-Type: application/json`.
4. Sign out of the site first (delete its cookies with CDP `Network.deleteCookies`), so the flow runs Google login, then `/consent`, then the callback.
5. Consent is remembered per client. To see the consent page again, change the metadata path (`/client2.json`) and click "Clear stored OAuth state" in the server settings.
6. Test both protocol eras (server settings > Protocol Era: Legacy and Modern).
7. Watch `wrangler tail --env preview` during the run; library errors (`APIError`, `Jwks failed`) only appear there.

### MCP 2026-07-28 list results

A hand-written stateless server must add `ttlMs` (number) and `cacheScope` (`"public"` or `"private"`) to `tools/list` results (CacheableResult). The Inspector rejects the result without them. Use `"private"` for per-user tools.

## Do not

- Import `mcp` from `better-auth/plugins`
- Register `oauthProvider()` next to `mcp()`
- Enable DCR by default
- Use `@better-auth/cimd/node` on Workers
- DNS-check then `fetch()` for CIMD on Node
- Use `connect()` sockets for CIMD on Workers (cannot reach Cloudflare-hosted metadata)
- Call `oauth2Consent` without `request` and `asResponse: false`
- Deploy `requireMcpAuth` on Workers without `global_fetch_strictly_public`
- Put OAuth on a stdio MCP server
- Skip `jwt()`
- Skip `/login` or `/consent`
- Rebuild `/oauth2/authorize` as Google `callbackURL`
- Use a `resource` URL with query or fragment
- Export GET/DELETE MCP routes for this profile
- Keep transports in isolate memory
- Let the MCP JWT hit `/api/v0`
- Use `epochMs` or any number-typed column for Better Auth dates
- CASCADE-delete `oauth_client` when a user is deleted
- Store OAuth arrays as plain `text` on D1
- Disable `cookieCache` to hide a Date vs number mismatch
