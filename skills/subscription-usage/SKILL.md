---
name: subscription-usage
description: >
  Check Claude Max/Pro and OpenAI ChatGPT/Codex subscription weekly usage through
  signed-in Chrome with Playwriter. Report ahead/behind weekly budget, reset time,
  and available past-30-day daily averages. Use for subscription quota, remaining
  allowance, weekly pacing, or Anthropic/OpenAI usage. Excludes five-hour limits.
---

# Subscription usage

Run the **network-only SDK**. It uses the user's signed-in Chrome through Playwriter.
No clicks, exported cookies, stored tokens, API keys, or purchases.

```bash
bun ~/.config/opencode/skills/subscription-usage/sdk.ts
```

Read `sdk.ts` before modifying it. For browser investigation, load the Playwriter
skill and run `playwriter skill`, reading the complete output without truncation.

## Script API

```ts
import { getSubscriptionUsage } from '/Users/morse/.config/opencode/skills/subscription-usage/sdk.ts'

const usage = await getSubscriptionUsage()
if (usage instanceof Error) throw usage
for (const provider of [usage.claude, usage.openai]) {
  if (provider instanceof Error) console.error(provider.message)
  else console.log(provider.weekly)
}
```

`getClaudeUsage({ page, organizationId? })` and `getOpenAIUsage({ page, accountId? })`
reuse pages already on their respective origins. The combined function opens and
closes its own two tabs. Select an organization explicitly if several support chat.
The SDK needs `playwriter` and `errore` available in the global
OpenCode environment. Run with Bun for TypeScript and disposable resources.

```text
script → Playwriter extension → signed-in site tab → authenticated fetch
                                                     ↓
                              weekly meters + OpenAI daily/history APIs
                                                     ↓
                              quota pacing, resets, coverage warnings
```

## Report weekly pacing

- **Ahead** means consuming faster than a linear seven-day budget, not a positive achievement.
- Compare `usedPercent` to `elapsedPercent`. Positive `aheadByPercentagePoints`
  means above budget; negative means below budget, with room to spare.
- Show remaining allowance, reset date/time, current-week daily rate, projected
  usage at reset, and sustainable daily allowance until reset.
- `remainingPercent` is available now. `projectedUnusedPercentAtReset` is the
  allowance expected to expire unused at the current-week average pace.
  `daysUntilReset` is the actual remaining time, not a fixed two-day assumption.
- Use the browser timezone for human dates. Also show UTC to remove ambiguity.
- Current-week projection assumes the present rate continues. It is not a forecast
  based on last month's behavior. Resets or changed allowances can distort history.
- Ignore five-hour meters and session limits. Keep promotional credits separate
  from weekly allowance. Never activate a reset or change account settings.

## Two-day reminders and Claude credits

Schedule each provider's reminder **48 hours before its live weekly reset**, in UTC.
For a weekly cron, subtract two days from the reset weekday and preserve its UTC
hour/minute. On each run verify the live reset, because manual resets can move it.
If the reminder is too early, correct the existing routine instead of duplicating it.

Report remaining percentage, projected unused percentage at reset, current-week
average percentage points/day, and the daily rate needed to use the allowance.
Suggest useful backlog work if substantial allowance would expire. Never start
tasks, spend money, or generate pointless work just to exhaust credits.

`cloudSessionCredits` reads the verified `usage.iguana_necktie` promotional meter.
It includes dollars remaining, remaining percentage, and expiration. These credits
are for Claude cloud sessions, **not an Anthropic API key**. They have their own
expiration, not the subscription's weekly reset.

`apiCredits: null` means **not verified**, not zero balance. Anthropic API billing
is separate. During this session the API console redirected to a signed-out
`platform.claude.com` page. Do not invent an API balance or promise credit-only
card safety. Do not create keys, change auto-reload, or edit Sigillo secrets in a
usage reminder. If the user wants API billing checked, inspect the signed-in API
console and verify the actual billing settings separately.

## Verified network endpoints

**Claude** uses cookie-authenticated same-origin fetch:

```text
GET /api/organizations                         select capabilities including "chat"
GET /api/organizations/{uuid}/usage             limits where group === "weekly"
```

Use `limits`, including scoped model labels. Do not assume all weekly limits are
in `seven_day_opus` or `seven_day_sonnet`. `seven_day_breakdown.window_started_at`
gives the all-model window start. Otherwise start is reset minus seven days.

**OpenAI** obtains authorization in memory, never in output or on disk:

```text
GET /api/auth/session                          accessToken and account.id
GET /backend-api/wham/usage                     live weekly quota, authoritative reset
GET /backend-api/wham/usage/plan_limit_history?days=30
GET /backend-api/wham/usage/daily-token-usage-breakdown
    ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&group_by=day
```

Send `Authorization: Bearer {accessToken}` and `chatgpt-account-id: {account.id}`.
Only keep windows with `limit_window_seconds === 604800`, regardless of primary
or secondary position. History uses `window_minutes === 10080` and basis points:
divide `used_basis_points` by 100 to get percent. History can be stale, incomplete,
and have earlier reset dates than the live meter. Always use the live reset.

## Past month and limitations

Use the **last 30 complete UTC dates**, excluding today. Sum each day's
`product_surface_usage_values` once. Do not also add model or attribution values;
those are parallel breakdowns of the same usage. Require `units === "percent"`.
Divide the total by 30 only when all 30 distinct dates are returned.

The values are **quota percentage points**, not raw tokens, dollars, or paid
overage credits. Even fields named `models[].credits` can have percent units.
Compare the daily average to `100 / 7 = 14.29` percentage points/day, but flag
quota changes and incomplete `planHistory` coverage. Daily analytics and the live
agentic weekly meter may have different scopes, including chat attribution.
Do not treat their difference as proof of an accounting error.

Claude's inspected personal APIs expose no monthly token/quota history.
`analytics/usage/overview` and `analytics/usage/timeseries?metric=chats&days=30`
return **chat counts**, not quota consumed, and miss Claude Code usage. Do not
substitute them or invent a monthly average. Report it as unavailable.

Verified on 2026-10-14 against live accounts. These are private website APIs and
can change. On HTTP or schema errors, use Playwriter network capture on Usage.
OpenAI's old `/codex/settings/usage` URL redirected to home; the observed dashboard
is `/settings/usage?tab=overview` or `tab=analytics`. Claude `/settings/usage`
redirected to `/new#settings/usage`.
