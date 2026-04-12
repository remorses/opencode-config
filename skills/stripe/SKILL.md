---
name: stripe
description: >
  Stripe billing patterns used in unframer-private. Covers creating products
  and prices via the Stripe CLI with stable lookup keys, multi-currency USD+EUR
  pricing, monthly/yearly subscriptions, type-safe Checkout and Billing Portal
  integration in spiceflow routes, webhook handling, and the rules for
  preventing double customers and double subscriptions in the database. Load
  this skill whenever adding, modifying, or debugging any Stripe code (prices,
  checkout sessions, portal sessions, webhooks, subscription logic) in this
  repo.
---

# Stripe

This repo uses **Stripe Checkout** for new purchases and the **Stripe Billing Portal** for subscription management (upgrade, downgrade, cancel, switch monthly↔yearly). We do not build our own billing UI.

Core rules, in priority order:

1. **One Stripe customer per `Org`**. Store the customer id in `Org.stripeCustomerId` and reuse it on every checkout/portal call.
2. **Never hardcode `price_xxx` ids** in app code. Use **`lookup_key`** and fetch prices at runtime.
3. **Every Price uses `currency_options` for EUR** on top of a USD base. Same integer value for both — see [Multi-currency](#multi-currency).
4. **One active Subscription row per `Org`**. Before creating a checkout session, check the DB and redirect existing subscribers to the portal instead.
5. **All Stripe-facing HTTP code lives inside spiceflow sub-apps** (`website/src/lib/spiceflow-*.tsx`). Not react-router actions. The webhook route is also a spiceflow route — spiceflow handlers receive a standard `Request` object, so `await request.text()` gives the raw body needed for Stripe's signature verification.
6. **Return errors as values, never throw.** All Stripe/Prisma calls are wrapped with `.catch()` into tagged [errore](../errore/SKILL.md) errors (`StripeApiError`, `DbError`, `PriceNotFoundError`, etc.). `constructEvent` and other sync-throwing APIs go through `errore.try`. Handlers check `instanceof Error`, early-return, and map errors to HTTP responses via `errore.matchError` at the HTTP boundary only.

## Env vars

This repo runs on **Vite + spiceflow**, not Next.js. Vite does not expose `process.env` to client code — in the browser you must use `import.meta.env.VITE_*`, and only variables prefixed `VITE_` are inlined into the client bundle. On the server (Node.js) `process.env` works normally.

Only three Stripe env vars should exist. The publishable key is the only one that runs in the browser:

```bash
# .env.local — committed to neither git nor the client bundle (server-only for the two secrets)
STRIPE_SECRET_KEY=sk_test_...              # server only, via process.env
STRIPE_WEBHOOK_SECRET=whsec_...            # server only, via process.env
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...    # client + server, via import.meta.env on the client
```

```ts
// website/src/lib/env.ts — server-side accessors
export const env = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  // Exposed so server code can also read it without reaching into import.meta.env
  VITE_STRIPE_PUBLISHABLE_KEY: process.env.VITE_STRIPE_PUBLISHABLE_KEY,
}
```

```ts
// Client-side code — React components, "use client" files, anything that ends up in the browser bundle
const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY
```

**Never use `process.env.*` in client code.** Vite will either leave it as the literal string `process.env.X` at runtime (which explodes as `ReferenceError: process is not defined`) or silently strip it. Only `import.meta.env.VITE_*` is safe in the browser.

**Never prefix `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` with `VITE_`.** Anything starting with `VITE_` is inlined into the client bundle and visible in devtools. If you accidentally rename the secret key to `VITE_STRIPE_SECRET_KEY`, you leak it to every visitor.

**Never add `STRIPE_PRICE_ID_FOO` env vars for each plan.** They bind code to a specific Stripe account at deploy time and block acquisition-readiness. Use `lookup_key` instead and the code stays identical across accounts.

### TypeScript types for `import.meta.env`

Add to `website/src/vite-env.d.ts` (or wherever the existing Vite env declaration lives):

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STRIPE_PUBLISHABLE_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

This gives autocomplete on `import.meta.env.VITE_*` and fails compilation if you typo the name.

### How to get each value

| Var | Where from | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `stripe login` → `cat ~/.config/stripe/config.toml` (restricted key `rk_*` works for most dev), or copy `sk_test_`/`sk_live_` from `https://dashboard.stripe.com/apikeys` once | Server only. Store in `doppler` / `.env.local`, never in the repo |
| `STRIPE_WEBHOOK_SECRET` | Dev: `stripe listen --print-secret`. Prod: returned once from `stripe webhook_endpoints create ...` | Server only. Returned only on endpoint creation — capture it |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Copy `pk_test_`/`pk_live_` from `https://dashboard.stripe.com/apikeys` | Safe to ship to the browser. Must be `VITE_`-prefixed so Vite inlines it into the client bundle |

### Local dev webhook loop

```bash
# Terminal 1 — run the site
pnpm dev

# Terminal 2 — forward Stripe events to the local webhook route
stripe listen --forward-to http://localhost:8040/api/stripe/webhooks
```

Copy the `whsec_...` it prints and set `STRIPE_WEBHOOK_SECRET` in `.env.local`. The secret is stable across restarts for the same machine.

## Creating products and prices via CLI

**Always use `lookup_key`** so app code references a stable string instead of a generated `price_xxx` id. This makes it safe to rotate prices, migrate accounts, or change numbers without redeploys.

### Naming convention

`<tier>_<interval>` — e.g. `pro_monthly`, `pro_yearly`, `team_monthly`, `team_yearly`. Keep tier names generic and decoupled from product branding so you can rename the product without rotating price lookup keys.

### Create a product once

Run this first. Copy the `id` from the JSON response into a shell variable before moving to the next step:

```bash
stripe products create \
  --name="Pro" \
  --description="Pro plan with full features"
```

Output includes `"id": "prod_SomeRealId"`. Now set the placeholder for the following commands:

```bash
export PRODUCT_ID=prod_SomeRealId   # replace with the id from above
```

The returned `prod_xxx` id doesn't need to leak into code — we look up by product via its prices' `lookup_key`.

### Create prices with monthly+yearly and USD+EUR

Run each of the two commands below **separately**, one at a time. After each one, confirm the response contains the expected `lookup_key` and `unit_amount` before moving on. `$PRODUCT_ID` is a placeholder — replace it with the id you exported above.

```bash
# 1. Monthly — $10/mo + €10/mo
stripe prices create \
  --product=$PRODUCT_ID \
  --currency=usd \
  --unit-amount=1000 \
  -d "recurring[interval]=month" \
  -d "currency_options[eur][unit_amount]=1000" \
  -d "lookup_key=pro_monthly" \
  -d "nickname=Pro Monthly" \
  -d "tax_behavior=exclusive"
```

Check the response, then run the next:

```bash
# 2. Yearly — $100/yr + €100/yr
stripe prices create \
  --product=$PRODUCT_ID \
  --currency=usd \
  --unit-amount=10000 \
  -d "recurring[interval]=year" \
  -d "currency_options[eur][unit_amount]=10000" \
  -d "lookup_key=pro_yearly" \
  -d "nickname=Pro Yearly" \
  -d "tax_behavior=exclusive"
```

After both succeed, verify the catalog:

```bash
stripe prices list \
  --lookup-keys pro_monthly \
  --lookup-keys pro_yearly
```

You should see both prices. If one is missing, create the missing one manually — do not re-run the whole block or you'll get "lookup_key already exists" errors.

> **Adding a second tier** (e.g. `team`): create a new product via `stripe products create --name="Team" ...`, then two more prices with lookup keys `team_monthly` and `team_yearly`. Add both new price ids to the portal configuration under a second `products[1]` entry. The pattern scales linearly.

### Multi-currency

**USD is the base currency** (top-level `currency` field on the Price). EUR is added via `currency_options[eur][unit_amount]`. We intentionally use the **same integer value** for both currencies — at typical EUR/USD rates this captures ~8–10% extra margin on EUR customers with zero code changes.

- `unit_amount` is in **cents** (zero-decimal currencies like JPY use whole units).
- Stripe picks the currency at checkout time based on the customer's `preferred_locales` or an explicit `currency` on the Checkout Session. Once a subscription is created, the currency is **locked** — the portal cannot switch currencies. This is fine: EUR users stay on EUR, USD users stay on USD.

### Monthly ↔ yearly switching

Customers upgrade/downgrade between `_monthly` and `_yearly` via the **Billing Portal**, not custom code. The portal supports this **only if both prices belong to the same product**. The portal configuration (see [Portal configuration](#portal-configuration)) lists both prices under the single product.

### Rotating a price

To change the price amount without losing the lookup key binding. Run these **one at a time**, reading the output between each step. `$NEW_PRICE` and `$OLD_PRICE` are placeholder shell variables — set them manually from the actual ids Stripe returns.

Step 1 — Create the new price **without** the lookup_key:

```bash
stripe prices create \
  --product=$PRODUCT_ID \
  --currency=usd \
  --unit-amount=1200 \
  -d "recurring[interval]=month" \
  -d "currency_options[eur][unit_amount]=1200" \
  -d "nickname=Pro Monthly v2" \
  -d "tax_behavior=exclusive"
```

Copy the returned `id` into `NEW_PRICE`:

```bash
export NEW_PRICE=price_NewIdFromAbove
```

Step 2 — Atomically transfer the lookup_key from the old price to the new one:

```bash
stripe prices update $NEW_PRICE \
  -d "lookup_key=pro_monthly" \
  -d "transfer_lookup_key=true"
```

Confirm the response shows `"lookup_key": "pro_monthly"` on the new price.

Step 3 — Find the old price id and deactivate it. Use `stripe prices list` to find it if you don't already have it:

```bash
export OLD_PRICE=price_OldIdYouLookedUp
stripe prices update $OLD_PRICE -d active=false
```

Existing subscriptions stay on the old price. New checkouts use the new price. No redeploy needed.

If Step 2 fails (for example because `transfer_lookup_key` isn't supported on that price type), the old price still owns the lookup key and nothing is broken — you can safely delete the dangling new price via `stripe prices update $NEW_PRICE -d active=false` and retry.

## Looking up prices by lookup_key at runtime

Never hardcode `price_xxx`. Create a typed helper and cache the lookup inside a module. All functions follow the [errore](../errore/SKILL.md) convention — return errors as values, never throw.

```ts
// website/src/lib/stripe.ts
import Stripe from 'stripe'
import * as errore from 'errore'
import { env } from 'website/src/lib/env'

export const stripe = new Stripe(env.STRIPE_SECRET_KEY!, {})

// Domain errors for every Stripe-adjacent failure. Each call site
// ends up with a typed union like `StripeApiError | PriceNotFoundError | T`
// so callers can branch exhaustively via matchError.
export class StripeApiError extends errore.createTaggedError({
  name: 'StripeApiError',
  message: 'Stripe API call failed: $operation',
}) {}

export class PriceNotFoundError extends errore.createTaggedError({
  name: 'PriceNotFoundError',
  message: 'Stripe price with lookup_key=$lookupKey not found. Create it with the CLI — see skills/stripe/SKILL.md.',
}) {}

// The complete list of lookup keys used in the app. Adding a new plan
// means adding a new member here and creating it via the CLI — nothing else.
export const priceLookupKeys = [
  'pro_monthly',
  'pro_yearly',
] as const

export type PriceLookupKey = (typeof priceLookupKeys)[number]

// Module-level cache as a Promise so concurrent callers share one in-flight
// request. On error, reset to null so the next call retries.
type PriceCache = Map<PriceLookupKey, Stripe.Price>
let priceCachePromise: Promise<PriceCache | StripeApiError> | null = null

async function loadPriceCache(): Promise<PriceCache | StripeApiError> {
  const response = await stripe.prices
    .list({
      lookup_keys: [...priceLookupKeys],
      active: true,
      expand: ['data.product'],
      limit: 100,
    })
    .catch((e) => new StripeApiError({ operation: 'prices.list', cause: e }))
  if (response instanceof Error) return response

  return new Map(
    response.data.map((p) => [p.lookup_key as PriceLookupKey, p]),
  )
}

export async function getPriceByLookupKey(lookupKey: PriceLookupKey) {
  priceCachePromise ??= loadPriceCache()
  const cache = await priceCachePromise
  if (cache instanceof Error) {
    priceCachePromise = null // retry on next call
    return cache
  }

  const price = cache.get(lookupKey)
  if (!price) return new PriceNotFoundError({ lookupKey })
  return price
}
```

Call sites look like:

```ts
const price = await getPriceByLookupKey('pro_monthly')
if (price instanceof Error) return price
// TypeScript knows price is Stripe.Price here
```

The `z.enum(priceLookupKeys)` on the `/checkout` route also gives compile-time plan validation at the HTTP boundary.

## Single customer per Org

**Rule: create a Stripe Customer once per `Org`, store its id in `Org.stripeCustomerId`, reuse it forever.** This is the single biggest lever for preventing duplicate customers, duplicate subscriptions, and broken portal sessions.

```ts
// website/src/lib/stripe.ts
import { prisma } from 'db'
import * as errore from 'errore'
import {
  stripe,
  StripeApiError,
} from 'website/src/lib/stripe'

export class DbError extends errore.createTaggedError({
  name: 'DbError',
  message: 'Database operation failed: $operation',
}) {}

export class OrgNotFoundError extends errore.createTaggedError({
  name: 'OrgNotFoundError',
  message: 'Org $orgId not found',
}) {}

/**
 * Get or create the Stripe customer for an org. Idempotent — safe to call
 * from any flow. This is the ONLY place in the codebase where
 * `stripe.customers.create` should be called.
 */
export async function getOrCreateStripeCustomer({
  orgId,
  email,
}: {
  orgId: string
  email: string | null | undefined
}) {
  const org = await prisma.org
    .findUnique({
      where: { orgId },
      select: { stripeCustomerId: true },
    })
    .catch((e) => new DbError({ operation: 'org.findUnique', cause: e }))
  if (org instanceof Error) return org
  if (org === null) return new OrgNotFoundError({ orgId })

  if (org.stripeCustomerId) return org.stripeCustomerId

  const customer = await stripe.customers
    .create({
      email: email || undefined,
      metadata: { orgId },
    })
    .catch((e) => new StripeApiError({ operation: 'customers.create', cause: e }))
  if (customer instanceof Error) return customer

  const updated = await prisma.org
    .update({
      where: { orgId },
      data: { stripeCustomerId: customer.id },
    })
    .catch((e) => new DbError({ operation: 'org.update', cause: e }))
  if (updated instanceof Error) return updated

  return customer.id
}
```

Every caller receives `string | DbError | OrgNotFoundError | StripeApiError` and must handle the failure modes explicitly:

```ts
const customerId = await getOrCreateStripeCustomer({ orgId, email })
if (customerId instanceof Error) return customerId
```

Never call `stripe.customers.create` anywhere else. Never pass `customer_email` to Checkout without also checking for an existing `stripeCustomerId` first — that creates a second customer row in Stripe on repeat purchases and the portal breaks (each customer has its own separate subscriptions).

## Spiceflow routes

All Stripe endpoints — including the webhook — live inside a single spiceflow sub-app. Handlers follow the errore pattern: check each result with `instanceof Error`, early return, keep the happy path at root indentation.

```tsx
// website/src/lib/spiceflow-billing.tsx
import { Spiceflow } from 'spiceflow'
import * as errore from 'errore'
import { z } from 'zod'
import { prisma } from 'db'
import { env } from 'website/src/lib/env'
import {
  stripe,
  getOrCreateStripeCustomer,
  getPriceByLookupKey,
  priceLookupKeys,
  StripeApiError,
  DbError,
} from 'website/src/lib/stripe'

// Returned when the upstream Stripe API call succeeds but the response
// shape is not what we expect (e.g. missing session.url).
export class StripeResponseError extends errore.createTaggedError({
  name: 'StripeResponseError',
  message: 'Unexpected Stripe response: $reason',
}) {}

const errorToResponse = (error: Error) =>
  errore.matchError(error, {
    StripeApiError: (e) => new Response(e.message, { status: 502 }),
    StripeResponseError: (e) => new Response(e.message, { status: 502 }),
    DbError: (e) => new Response(e.message, { status: 500 }),
    OrgNotFoundError: (e) => new Response(e.message, { status: 404 }),
    PriceNotFoundError: (e) => new Response(e.message, { status: 404 }),
    Error: (e) => new Response(e.message, { status: 500 }),
  })

export const billingApp = new Spiceflow({ basePath: '/billing' })
  .state('orgId', Promise.resolve(''))
  .state('userEmail', Promise.resolve(''))

  // Create a Checkout Session OR redirect to the portal if the org
  // already has an active subscription. Prevents double subscriptions
  // by construction.
  .post(
    '/checkout',
    async ({ request, state }) => {
      const orgId = await state.orgId
      if (!orgId) return new Response('Unauthorized', { status: 401 })

      const email = await state.userEmail
      const body = await request.json()

      const customerId = await getOrCreateStripeCustomer({ orgId, email })
      if (customerId instanceof Error) return errorToResponse(customerId)

      // 1. If already subscribed, short-circuit to the portal
      const existing = await prisma.subscription
        .findFirst({
          where: {
            orgId,
            status: { in: ['active', 'trialing', 'past_due'] },
          },
        })
        .catch(
          (e) =>
            new DbError({ operation: 'subscription.findFirst', cause: e }),
        )
      if (existing instanceof Error) return errorToResponse(existing)

      if (existing) {
        const portal = await stripe.billingPortal.sessions
          .create({
            customer: customerId,
            return_url: new URL(body.returnPath, env.PUBLIC_URL).toString(),
          })
          .catch(
            (e) =>
              new StripeApiError({
                operation: 'billingPortal.sessions.create',
                cause: e,
              }),
          )
        if (portal instanceof Error) return errorToResponse(portal)
        return { url: portal.url, mode: 'portal' as const }
      }

      // 2. Otherwise start a new Checkout
      const price = await getPriceByLookupKey(body.lookupKey)
      if (price instanceof Error) return errorToResponse(price)

      const session = await stripe.checkout.sessions
        .create({
          mode: 'subscription',
          customer: customerId,
          line_items: [{ price: price.id, quantity: 1 }],
          success_url: new URL(body.returnPath, env.PUBLIC_URL).toString(),
          cancel_url: new URL(body.returnPath, env.PUBLIC_URL).toString(),
          allow_promotion_codes: true,
          client_reference_id: orgId,
          // Metadata is written to BOTH the checkout session AND the
          // resulting subscription so webhooks can always resolve orgId.
          metadata: { orgId },
          subscription_data: {
            metadata: { orgId },
          },
        })
        .catch(
          (e) =>
            new StripeApiError({
              operation: 'checkout.sessions.create',
              cause: e,
            }),
        )
      if (session instanceof Error) return errorToResponse(session)
      if (!session.url) {
        return errorToResponse(
          new StripeResponseError({ reason: 'checkout session has no url' }),
        )
      }

      return { url: session.url, mode: 'checkout' as const }
    },
    {
      body: z.object({
        lookupKey: z.enum(priceLookupKeys),
        returnPath: z.string().default('/billing/done'),
      }),
    },
  )

  // Open the portal for an existing customer. Used by the "Manage
  // subscription" button inside the app.
  .post(
    '/portal',
    async ({ request, state }) => {
      const orgId = await state.orgId
      if (!orgId) return new Response('Unauthorized', { status: 401 })

      const body = await request.json()
      const email = await state.userEmail

      const customerId = await getOrCreateStripeCustomer({ orgId, email })
      if (customerId instanceof Error) return errorToResponse(customerId)

      // Find the most recent active sub for the upgrade flow, if requested.
      const sub = body.forSubscriptionUpgrade
        ? await prisma.subscription
            .findFirst({
              where: {
                orgId,
                status: { in: ['active', 'trialing'] },
              },
              orderBy: { createdAt: 'desc' },
            })
            .catch(
              (e) =>
                new DbError({
                  operation: 'subscription.findFirst',
                  cause: e,
                }),
            )
        : null
      if (sub instanceof Error) return errorToResponse(sub)

      const portal = await stripe.billingPortal.sessions
        .create({
          customer: customerId,
          return_url: new URL(body.returnPath, env.PUBLIC_URL).toString(),
          flow_data:
            sub && body.forSubscriptionUpgrade
              ? {
                  type: 'subscription_update',
                  subscription_update: { subscription: sub.subscriptionId },
                }
              : undefined,
        })
        .catch(
          (e) =>
            new StripeApiError({
              operation: 'billingPortal.sessions.create',
              cause: e,
            }),
        )
      if (portal instanceof Error) return errorToResponse(portal)

      return { url: portal.url }
    },
    {
      body: z.object({
        returnPath: z.string().default('/billing/done'),
        forSubscriptionUpgrade: z.boolean().optional(),
      }),
    },
  )

export type BillingApp = typeof billingApp
```

Notes on the pattern:

- **`errorToResponse`** is a single `matchError` call that maps tagged domain errors to HTTP status codes. Add a new case whenever you introduce a new tagged error. The required `Error` fallback handles untagged `Error` instances.
- **Happy path at root**: every `instanceof Error` check is followed by an early return. The successful `return { url, mode }` is at the top indentation level, never buried inside an `if`.
- **Never use `try/catch`** for Stripe or Prisma calls. `.catch()` converts the thrown error into a typed domain error at the boundary. Your handler logic becomes a sequence of `const x = await ...; if (x instanceof Error) return ...`.
- **`.catch()` always wraps in a tagged error with `cause`** — never `.catch((e) => e as Error)`. The original error is preserved in `cause` for debugging.

Type-safe client usage from other parts of the app. The spiceflow client is a proxy-style typed client from `spiceflow/client` — access routes as `client.path.method(body)` and destructure `{ data, error }` from the response. Combine with errore's "wrap the error in a tagged domain error" pattern for a full errors-as-values flow.

```ts
// website/src/lib/billing-client.ts
import { createSpiceflowClient } from 'spiceflow/client'
import * as errore from 'errore'
import type { RouteType } from 'website/src/lib/spiceflow-plugins.server'
import type { PriceLookupKey } from 'website/src/lib/stripe'

export class BillingClientError extends errore.createTaggedError({
  name: 'BillingClientError',
  message: 'Billing API call failed: $operation',
}) {}

export const apiClient = createSpiceflowClient<RouteType>(env.PUBLIC_URL!)

export async function startCheckout(lookupKey: PriceLookupKey) {
  // The proxy maps the route path to dot access — the /billing/checkout
  // route mounted under /api/plugins becomes apiClient.api.plugins.billing.checkout.
  const { data, error } = await apiClient.api.plugins.billing.checkout.post({
    lookupKey,
    returnPath: '/billing/done',
  })
  if (error) return new BillingClientError({ operation: 'checkout', cause: error })

  window.location.href = data.url
  return null
}
```

Call site on the client:

```ts
const result = await startCheckout('pro_monthly')
if (result instanceof Error) {
  console.error('Checkout failed:', result.message)
  toast.error('Could not start checkout — please try again')
}
```

Notes:

- The `z.enum(priceLookupKeys)` on the `/checkout` route gives **autocomplete on every call site** and fails compilation if you typo a plan name. TypeScript infers the body shape from the route definition.
- **Wrap `error` in a tagged domain error**, don't return it as-is. The SDK error is a plain object — wrapping in `BillingClientError` gives you `_tag`, typed properties, and a `cause` chain for debugging.
- **Check `error` with a truthy check**, not `instanceof Error`. The spiceflow client returns plain `{ data: T | null, error: SomeErrorShape | null }` — similar to Supabase.

## Webhook handler

The webhook is a **spiceflow route**, just like `/checkout` and `/portal`. Spiceflow handlers receive a standard Web `Request`, so `await request.text()` gives you the exact raw body bytes that Stripe signed — which is what `stripe.webhooks.constructEvent` needs for signature verification.

Do **not** parse the body with `await request.json()` before verifying the signature. JSON parsing normalizes whitespace and key order, which breaks the HMAC check. Always call `await request.text()` first.

The handler uses the errore pattern: `constructEvent` is a throwing sync API, so wrap it with `errore.try`. Every DB write is a `.catch()` boundary with a tagged error. Handler dispatch is a sequence of early returns, no `try/catch` for control flow.

```ts
// website/src/lib/spiceflow-billing.tsx — same sub-app as /checkout and /portal
import * as errore from 'errore'
import {
  stripe,
  handleCheckoutSessionCompleted,
  handleSubscriptionChange,
} from 'website/src/lib/stripe'
import { env } from 'website/src/lib/env'
import { notifyError } from 'website/src/lib/errors'

export class WebhookSignatureError extends errore.createTaggedError({
  name: 'WebhookSignatureError',
  message: 'Stripe webhook signature verification failed',
}) {}

export const billingApp = new Spiceflow({ basePath: '/billing' })
  // ... /checkout and /portal routes above ...

  .post('/webhook', async ({ request }) => {
    const sig = request.headers.get('stripe-signature')
    if (!sig) return new Response('No signature', { status: 400 })

    // spiceflow exposes the full raw request body via request.text().
    // Must be called BEFORE any other body parsing — reading the stream
    // twice is an error.
    const rawBody = await request.text()

    // constructEvent is a throwing SYNC API — wrap it with errore.try
    // rather than a try/catch statement.
    const event = errore.try({
      try: () =>
        stripe.webhooks.constructEvent(
          rawBody,
          sig,
          env.STRIPE_WEBHOOK_SECRET!,
        ),
      catch: (e) => new WebhookSignatureError({ cause: e }),
    })
    if (event instanceof Error) {
      notifyError(event, 'Stripe webhook signature')
      return new Response('Bad signature', { status: 400 })
    }

    const result = await (async () => {
      if (event.type === 'checkout.session.completed') {
        return handleCheckoutSessionCompleted(event.data.object)
      }
      if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        return handleSubscriptionChange(event.data.object)
      }
      return null // unhandled event type — ignore silently
    })()

    if (result instanceof Error) {
      notifyError(result, `Stripe webhook ${event.type}`)
      return new Response('Webhook failed', { status: 500 })
    }

    return new Response('ok', { status: 200 })
  })
```

And the dispatchers in `website/src/lib/stripe.ts`, following the same errore conventions:

```ts
// website/src/lib/stripe.ts
import Stripe from 'stripe'
import * as errore from 'errore'
import { prisma, Prisma } from 'db'
import { stripe, StripeApiError, DbError } from 'website/src/lib/stripe'

export class OrgResolutionError extends errore.createTaggedError({
  name: 'OrgResolutionError',
  message: 'Could not resolve orgId for Stripe event: $context',
}) {}

export async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
) {
  // Always re-fetch — event payload can be stale in out-of-order delivery.
  const latest = await stripe.checkout.sessions
    .retrieve(session.id, { expand: ['line_items'] })
    .catch(
      (e) =>
        new StripeApiError({
          operation: 'checkout.sessions.retrieve',
          cause: e,
        }),
    )
  if (latest instanceof Error) return latest

  const customerEmail = latest.customer_details?.email || null

  const orgId = await resolveStripeOrgId({
    metadataOrgId: latest.metadata?.orgId,
    customerEmail,
    context: `checkout.session.completed (${latest.id})`,
  })
  if (orgId instanceof Error) return orgId
  if (orgId === null) return null // unroutable webhook — drop it

  const item = latest.line_items?.data[0]
  if (!item || !item.price?.id) return null // nothing to record

  const record: Prisma.PaymentForCreditsCreateManyInput = {
    id: latest.id,
    email: customerEmail || '',
    variantName: item.description || '',
    orderId: latest.id,
    productId: item.price.product.toString(),
    variantId: item.price.id,
    provider: 'stripe',
    orgId,
    metadata: latest.metadata || {},
  }

  const upsertResult = await prisma.paymentForCredits
    .upsert({
      where: { id: latest.id },
      create: record,
      update: record,
    })
    .catch(
      (e) => new DbError({ operation: 'paymentForCredits.upsert', cause: e }),
    )
  if (upsertResult instanceof Error) return upsertResult

  return null
}

export async function handleSubscriptionChange(
  subscription: Stripe.Subscription,
) {
  const latest = await stripe.subscriptions
    .retrieve(subscription.id)
    .catch(
      (e) =>
        new StripeApiError({
          operation: 'subscriptions.retrieve',
          cause: e,
        }),
    )
  if (latest instanceof Error) return latest

  const metadataEmail = latest.metadata?.email || null
  const orgId = await resolveStripeOrgId({
    metadataOrgId: latest.metadata?.orgId,
    customerEmail: metadataEmail,
    context: `customer.subscription event (${latest.id})`,
  })
  if (orgId instanceof Error) return orgId
  if (orgId === null) return null

  const firstItem = latest.items.data[0]
  if (!firstItem) {
    return new OrgResolutionError({
      context: `No items in subscription ${latest.id}`,
    })
  }

  const record: Prisma.SubscriptionCreateManyInput = {
    orgId,
    orderId: latest.id,
    productId: firstItem.price.product.toString(),
    variantId: firstItem.price.id,
    subscriptionId: latest.id,
    email: metadataEmail || undefined,
    status: latest.status,
    variantName: firstItem.price.nickname || undefined,
    createdAt: new Date(latest.created * 1000),
    metadata: latest.metadata || {},
    provider: 'stripe',
    customerId: latest.customer.toString(),
  }

  const upsertResult = await prisma.subscription
    .upsert({
      where: {
        subscriptionId_variantId: {
          subscriptionId: latest.id,
          variantId: firstItem.price.id,
        },
      },
      create: record,
      update: record,
    })
    .catch(
      (e) => new DbError({ operation: 'subscription.upsert', cause: e }),
    )
  if (upsertResult instanceof Error) return upsertResult

  return null
}

async function resolveStripeOrgId({
  metadataOrgId,
  customerEmail,
  context,
}: {
  metadataOrgId: string | undefined
  customerEmail: string | null
  context: string
}) {
  // 1. Primary path — metadata orgId set by the checkout session
  if (!metadataOrgId) {
    console.warn(`No orgId in Stripe metadata for ${context}`)
  }
  if (metadataOrgId) {
    const org = await prisma.org
      .findUnique({
        where: { orgId: metadataOrgId },
        select: { orgId: true },
      })
      .catch((e) => new DbError({ operation: 'org.findUnique', cause: e }))
    if (org instanceof Error) return org
    if (org) return org.orgId
    console.warn(`Stripe webhook unknown orgId ${metadataOrgId} for ${context}`)
  }

  // 2. Fallback — match the customer email to a known user's first org
  if (!customerEmail) return null

  const user = await prisma.users
    .findFirst({
      where: { email: customerEmail },
      include: { orgs: true },
    })
    .catch((e) => new DbError({ operation: 'users.findFirst', cause: e }))
  if (user instanceof Error) return user

  return user?.orgs?.[0]?.orgId ?? null
}
```

**Do not add a Zod `body` schema to the webhook route.** Zod would try to parse the body as JSON, which either double-consumes the stream or normalizes whitespace and breaks HMAC verification. The raw-text handler above is the only correct pattern.

**Register the webhook URL with Stripe** once the route is mounted:

```bash
# Replace with your deployed URL
stripe webhook_endpoints create \
  --url="https://your-site.example/api/plugins/billing/webhook" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.created" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted"
```

Capture the returned `secret` field (only shown once) as `STRIPE_WEBHOOK_SECRET`. For local development, use `stripe listen --forward-to http://localhost:8040/api/plugins/billing/webhook` and use its `whsec_` instead.

### Idempotency on upserts

Webhooks are delivered at-least-once. Every write must be an upsert keyed on a stable column so retries are safe. The existing pattern:

- `PaymentForCredits` is upserted on `id = checkout_session_id`
- `Subscription` is upserted on the composite key `@@id([subscriptionId, variantId])`

When a subscription event arrives, always re-fetch the latest object from Stripe before writing to the DB — the event payload may be stale if events arrive out of order:

```ts
const latest = await stripe.subscriptions.retrieve(subscription.id)
```

### Resolving orgId from webhook events

Always write `metadata.orgId` on **both** the Checkout Session and its `subscription_data.metadata`. Webhooks need it on both because `checkout.session.completed` exposes session metadata, while `customer.subscription.*` exposes subscription metadata.

Fallback chain:

1. `metadata.orgId` on the event object
2. Email lookup: find the user by `customer_details.email` and return their first org

Never rely only on email. It's a fallback because users can change email in Stripe Checkout and break the mapping.

### Mounting the billing sub-app

Register `billingApp` in the parent spiceflow router via `.use(billingApp)`. The final webhook URL is the parent router's `basePath` + `/billing/webhook`.

```ts
// website/src/lib/spiceflow-plugins.server.tsx
import { billingApp } from 'website/src/lib/spiceflow-billing'

export const spiceflowApp = new Spiceflow({
  disableSuperJsonUnlessRpc: false,
  basePath: '/api/plugins',
})
  // ... other sub-apps ...
  .use(billingApp) // ← /api/plugins/billing/checkout, /portal, /webhook
```

The webhook is publicly reachable — it does not need session auth. Stripe authenticates via the `stripe-signature` header and `constructEvent`. If your parent router has an auth middleware that reads `state.orgId`, make sure the webhook handler never awaits that state so it runs fine for unauthenticated Stripe requests. The common pattern is a middleware that resolves `state.orgId` to an empty string when no session key is present.

## Preventing double subscriptions

Two layers of defense, both required:

**Layer 1 — DB check before checkout.** Inside the `/checkout` route, query `prisma.subscription` for an active row for this `orgId`. If one exists, return the portal URL instead of creating a new Checkout Session. This is the primary guard.

```ts
const existing = await prisma.subscription
  .findFirst({
    where: {
      orgId,
      status: { in: ['active', 'trialing', 'past_due'] },
    },
  })
  .catch(
    (e) => new DbError({ operation: 'subscription.findFirst', cause: e }),
  )
if (existing instanceof Error) return errorToResponse(existing)
if (existing) return openPortal(existing.customerId)
```

**Layer 2 — Single Stripe customer per org.** Because `Org.stripeCustomerId` is reused across every checkout, Stripe itself won't let the same customer subscribe twice to the same recurring price. Even if the DB check somehow races, Stripe returns an error and we never end up with two parallel subs for the same plan.

**Do not** rely on `customer_email` to deduplicate — Stripe will happily create a second customer with the same email if you don't pass an explicit `customer` id.

## Preventing double customers

Same pattern: `getOrCreateStripeCustomer({ orgId })` is the only function in the codebase that calls `stripe.customers.create`. Grep for it as a code review check:

```bash
rg "stripe\.customers\.create" website/src
# Should match ONLY getOrCreateStripeCustomer in website/src/lib/stripe.ts
```

If you find a second call site, delete it and route through `getOrCreateStripeCustomer` instead.

The `Org.stripeCustomerId` column in `db/schema.prisma` is the single source of truth. It is set exactly once per org, the first time that org interacts with Stripe, and never updated afterward except on acquisition-style migrations.

## Portal configuration

The Billing Portal must be configured **once** per Stripe account so customers can cancel, switch plans, and update payment methods. Do this via the CLI, not via the dashboard, so the config is reproducible.

### Step 1 — collect the product and price ids

All the `$PRODUCT_ID`, `$PRO_MONTHLY`, `$PRO_YEARLY` variables below are **placeholder shell variables used for illustration only**. They are not stored anywhere. You set them manually in your current shell session from the ids Stripe returned when you created the product and prices earlier.

```bash
# Replace each value with the real id from the product/price creation steps above
export PRODUCT_ID=prod_yourProductIdHere
export PRO_MONTHLY=price_yourMonthlyIdHere
export PRO_YEARLY=price_yourYearlyIdHere
```

If you don't have the ids anymore, look them up with:

```bash
stripe prices list --lookup-keys pro_monthly --lookup-keys pro_yearly
```

### Step 2 — create the portal configuration

Run this as a **single atomic call** — unlike the product/price flow, a portal configuration is created in one Stripe API call, so there is no partial-state risk within the command. But do not chain it after the price creation commands in a script; the shell variables above must already be set and verified before you run it.

```bash
stripe billing_portal configurations create \
  -d "business_profile[headline]=Manage your subscription" \
  -d "features[customer_update][enabled]=true" \
  -d "features[customer_update][allowed_updates][0]=email" \
  -d "features[customer_update][allowed_updates][1]=address" \
  -d "features[customer_update][allowed_updates][2]=tax_id" \
  -d "features[invoice_history][enabled]=true" \
  -d "features[payment_method_update][enabled]=true" \
  -d "features[subscription_cancel][enabled]=true" \
  -d "features[subscription_cancel][mode]=at_period_end" \
  -d "features[subscription_cancel][cancellation_reason][enabled]=true" \
  -d "features[subscription_cancel][cancellation_reason][options][0]=too_expensive" \
  -d "features[subscription_cancel][cancellation_reason][options][1]=missing_features" \
  -d "features[subscription_cancel][cancellation_reason][options][2]=switched_service" \
  -d "features[subscription_cancel][cancellation_reason][options][3]=unused" \
  -d "features[subscription_cancel][cancellation_reason][options][4]=other" \
  -d "features[subscription_update][enabled]=true" \
  -d "features[subscription_update][default_allowed_updates][0]=price" \
  -d "features[subscription_update][default_allowed_updates][1]=promotion_code" \
  -d "features[subscription_update][proration_behavior]=create_prorations" \
  -d "features[subscription_update][products][0][product]=$PRODUCT_ID" \
  -d "features[subscription_update][products][0][prices][0]=$PRO_MONTHLY" \
  -d "features[subscription_update][products][0][prices][1]=$PRO_YEARLY" \
  -d "features[subscription_update][schedule_at_period_end][conditions][0][type]=shortening_interval" \
  -d "features[subscription_update][schedule_at_period_end][conditions][1][type]=decreasing_item_amount"
```

Listing both price ids under the same product is what enables portal-driven monthly↔yearly switching. The `schedule_at_period_end` conditions make sure downgrades (yearly → monthly, or higher → lower tier) wait until the end of the billing period instead of refunding early.

If the command fails because any of the `$PRODUCT_ID`, `$PRO_MONTHLY`, or `$PRO_YEARLY` shell variables is empty or points to a non-existent id, Stripe returns a clean error and creates nothing — safe to fix and retry.

> **Adding more tiers**: append a second product under `products[1][product]=$TEAM_PRODUCT` with its own `prices[0]=$TEAM_MONTHLY` / `prices[1]=$TEAM_YEARLY`. The portal will let customers switch between any of the 4 prices (pro monthly, pro yearly, team monthly, team yearly).

## DB reference

From `db/schema.prisma`:

```prisma
model Org {
  orgId            String          @id @default(cuid())
  stripeCustomerId String?         // ← single source of truth for the customer
  subscriptions    Subscription[]
  payments         PaymentForCredits[]
  // ...
}

model Subscription {
  subscriptionId String
  variantId      String              // ← Stripe price id (rename target: stripePriceId)
  productId      String              // ← Stripe product id
  customerId     String?             // ← Stripe customer id, denormalized from Org
  orgId          String
  status         SubscriptionStatus  // active, trialing, canceled, past_due, ...
  provider       PaymentProvider     // stripe | lemonsqueezy (legacy)
  metadata       Json?
  org            Org                 @relation(fields: [orgId], references: [orgId])

  @@id([subscriptionId, variantId])  // idempotent upsert key for webhooks
  @@index([orgId])
}
```

The composite primary key `(subscriptionId, variantId)` lets a single subscription carry multiple line items (e.g. base plan + add-on) without the upsert colliding.

## Common gotchas

- **`disableSuperJsonUnlessRpc: false`**: spiceflow sub-apps in this repo use this flag so they can return plain JSON over HTTP for direct redirects. Keep it when you add billing routes.
- **Portal can't switch currency.** Once a sub is USD, it stays USD. If a user wants EUR they have to cancel and re-subscribe. Don't try to build a "change currency" button — Stripe won't let you.
- **`tax_behavior` must match across prices of the same product.** Set it to `exclusive` on every price in the CLI commands above. If one price is `unspecified` and another is `exclusive`, the portal refuses to let users switch between them.
- **`customer_email` vs `customer`.** Never pass `customer_email` if you have a `customer` id. Passing both makes Stripe ignore `customer_email`, which creates confusing UX bugs.
- **Stripe CLI is a live API.** Everything in this skill runs against the key in `~/.config/stripe/config.toml`. Test against a sandbox (`stripe login --project-name=sandbox`) before running price-creation commands against production.
- **Webhooks must return 2xx quickly** (< 5s). If you need to run heavy work, enqueue it to QStash (see `website/src/lib/qstash.ts`) and return 200 immediately.
- **Webhook raw body**: call `await request.text()` exactly once in the webhook handler. Calling `request.json()` first (or letting a Zod `body` schema parse the request) consumes the stream and breaks signature verification. Do not add a `body:` schema on the webhook route.
- **`Subscription.variantId` is the Stripe price id.** The name is historical from the LemonSqueezy days. Do not confuse it with the lookup key.
- **Price cache invalidates on error.** `priceCachePromise` stores the in-flight Promise so concurrent calls share one API request. When it resolves to an error, the module resets `priceCachePromise = null` so the next call retries. Don't "fix" this by keeping the error cached — it would permanently break price lookups until a process restart.
- **Errors as values.** Every Stripe/Prisma call in this codebase returns `Error | T` via `.catch((e) => new TaggedError({ cause: e }))`. Never throw from a helper function. Never use `try/catch` around Stripe calls — it just replaces one early return with two nested blocks. See the [errore skill](../errore/SKILL.md) for the full pattern.
