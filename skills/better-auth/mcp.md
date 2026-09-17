# MCP OAuth with Better Auth

Use this when an app needs a **remote HTTP MCP** that Cursor, Claude, VS Code, or other MCP clients can add with OAuth. Do **not** use this for local stdio (`mycli mcp`). Stdio reuses the CLI session from `deviceAuthorization` + `bearer`.

Canonical docs (fetch in full, never truncate):

- https://better-auth.com/docs/plugins/mcp
- https://better-auth.com/docs/plugins/cimd
- https://better-auth.com/docs/plugins/oauth-provider
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

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
  /oauth2/token  (PKCE, resource-bound JWT)
        │
        ▼
  POST /mcp  behind requireMcpAuth
```

Better Auth owns login, consent, discovery, PKCE, tokens, and challenges. The official MCP SDK v2 owns JSON-RPC transport. Do not mix those jobs.

## When to add it

Add `@better-auth/mcp` only if users will connect with a URL like `https://example.com/mcp`.

Skip it when:

- MCP is **stdio** on a CLI binary (`createMcpAction` from `@goke/mcp`)
- The agent already logs in with `mycli login` (device flow) and the local process has a saved session

Local stdio + hosted HTTP can coexist. They use different auth. Stdio uses the session cookie / bearer from device flow. HTTP MCP uses OAuth access tokens bound to the MCP resource.

## Packages

Never import `mcp` from `better-auth/plugins`. That plugin is deprecated. The current package is `@better-auth/mcp` (1.7+), built on `@better-auth/oauth-provider`.

```bash
pnpm add @better-auth/mcp @better-auth/cimd @modelcontextprotocol/server
```

`jwt()` from `better-auth/plugins` is required. It signs access tokens and serves `/jwks`.

Do **not** also register `oauthProvider()`. `mcp()` is already the OAuth provider.

## Auth config

```ts
import { betterAuth } from 'better-auth/minimal'
import { jwt } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'

const MCP_RESOURCE = 'https://example.com/mcp'

export const auth = betterAuth({
  plugins: [
    jwt(),
    mcp({
      loginPage: '/login',
      consentPage: '/consent',
      resource: MCP_RESOURCE,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: 'mcp-2026-07-28',
    }),
  ],
})
```

`resource` must be an HTTPS URL with no query, fragment, or credentials. HTTP is allowed only on loopback. That value is the token `aud` and the RFC 9728 resource identifier. Pass the **same string** to `requireMcpAuth`.

`loginPage` and `consentPage` are required. Users hit `/login` then `/consent` during the MCP OAuth flow. The app must already have a `/login` page. Add a `/consent` page that calls `auth.api.oauth2Consent`.

## CIMD

**CIMD** (Client ID Metadata Document) is how MCP clients identify themselves without Dynamic Client Registration. The client's `client_id` is an HTTPS URL that hosts JSON metadata (`client_name`, `redirect_uris`, keys). Better Auth fetches that URL and stores the client in `oauthClient` with `clientDiscoveryId: "cimd"`.

MCP 2026-07-28 deprecates DCR. Always add `cimd()` with `metadataProfile: "mcp-2026-07-28"`. Do not enable `allowDynamicClientRegistration` unless you must support old clients.

`fetchClientMetadataResource` is required. `@better-auth/cimd/node` is **Node only**. It resolves DNS once, rejects private IPs, pins the address, and refuses redirects.

On **Cloudflare Workers, Bun, Deno**, do not use the Node helper and do not `fetch` after a separate DNS check. Inject a transport that:

1. Parses the target as HTTPS before resolving
2. Resolves the hostname once and rejects RFC 6890 special-use addresses
3. Connects to that address while keeping TLS hostname checks for the original host
4. Refuses redirects

Without that, CIMD is open to DNS rebinding.

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
| `oauthClient` | clients. CIMD sets `clientDiscoveryId` to `"cimd"` |
| `oauthResource` | MCP URL as `aud` |
| `oauthClientResource` | which client can request which resource |
| `oauthRefreshToken` | refresh tokens |
| `oauthAccessToken` | opaque tokens when there is no JWT audience |
| `oauthConsent` | user consent |
| `oauthClientAssertion` | `private_key_jwt` `jti` replay |

`oauthClient.clientId` must accept **URLs**, not only ULIDs. CIMD ids look like `https://cursor.com/.well-known/oauth-client`.

`clientDiscoveryId` is nullable. `"cimd"` means CIMD owns the row. `NULL` means admin or DCR created it. Never set it by inspecting whether `clientId` starts with `https://`.

Prisma references with the 1.7 shape:

- https://github.com/elie222/inbox-zero/blob/main/apps/web/prisma/schema.prisma
- https://github.com/OtaKit/otakit/blob/main/packages/console/prisma/schema.prisma
- Official fields: https://github.com/better-auth/better-auth/blob/main/packages/oauth-provider/src/schema.ts

Existing `deviceCode` tables for CLI login stay. Do not replace device flow with MCP OAuth.

SQLite / D1 extra rules for these tables:

- Date columns are Better Auth `type: "date"`. Use `authDate` or `integer({ mode: 'timestamp_ms' })`, not app `epochMs`. Cookie cache is `z.date()`.
- `string[]` and `json` fields must be `text(name, { mode: 'json' })`. The drizzle adapter `supportsArrays: true` does not stringify for SQLite.
- Copy foreign keys from the official OAuth schema. Do not invent `onDelete: 'cascade'` on `oauthClient.userId`. Token rows reference that client with `NO ACTION`.

## Protect the MCP route

MCP 2026-07-28 is stateless HTTP `POST`. Export only `POST`. Reject legacy session protocol.

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

`requireMcpAuth` checks the `Authorization` header against JWKS (issuer, audience, expiry, DPoP when bound). Unauthenticated calls get JSON-RPC **401** plus RFC 9728 `WWW-Authenticate`. Missing scopes get **403** `insufficient_scope` so the client can step up.

If the MCP server is a different origin than Better Auth, use `createMcpProtectedRequestHandler` with explicit `issuer`, `audience`, and `jwksUrl`.

## Spiceflow

Keep forwarding `/api/auth` to `auth.handler`. OAuth discovery and `/oauth2/*` live under that prefix. Also make sure issuer well-known URLs reach the handler:

- `{issuer}/.well-known/oauth-authorization-server`
- `/.well-known/oauth-authorization-server/[issuer-path]`
- `/.well-known/oauth-protected-resource`

If Holocron or the app 404s those paths, add routes that call `auth.handler`, or add them to `knownPaths` only after they actually exist.

Mount the MCP `POST` next to the API, not under `/api/auth`.

```ts
app.route({
  method: 'POST',
  path: '/mcp',
  handler: ({ request }) => POST(request),
})
```

Add `/consent` as a page. The user must be signed in. Call `auth.api.oauth2Consent` with the request headers.

## CLI vs remote MCP

| Surface | Auth |
| --- | --- |
| `mycli mcp` (stdio) | Saved session from `deviceAuthorization` + `bearer` |
| `https://example.com/mcp` | `@better-auth/mcp` OAuth 2.1 + CIMD |

Optional: `oauthDeviceAuthorization({ verificationUri: '/device' })` next to `mcp()` if a **registered public CLI** should get the same audience-bound MCP token without a local callback. That does not replace auth-code + PKCE for Cursor and Claude. Do not add it unless the CLI implements RFC 8628 against `/device/code` and `/oauth2/token`.

Keep the existing CLI `deviceAuthorization` plugin for `mycli login`. That flow issues a Better Auth session, not an MCP resource token.

## Do not

- Import `mcp` from `better-auth/plugins`
- Register `oauthProvider()` next to `mcp()`
- Enable DCR by default
- Use `@better-auth/cimd/node` on Workers
- Put OAuth on a stdio MCP server
- Skip `jwt()`
- Skip `/login` or `/consent`
- Use a `resource` URL with query or fragment
- Export GET/DELETE MCP routes for the 2026-07-28 profile
