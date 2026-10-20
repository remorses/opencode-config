import { connectViaExtension } from 'playwriter'
import * as errore from 'errore'

type Connection = Awaited<ReturnType<typeof connectViaExtension>>
type Context = ReturnType<Connection['browser']['contexts']>[number]
type Page = Awaited<ReturnType<Context['newPage']>>

const DAY = 86_400_000
const WEEK = 7 * DAY

export class UsageError extends errore.createTaggedError({
  name: 'UsageError',
  message: '$reason',
}) {}

export interface WeeklyLimit {
  name: string
  usedPercent: number
  remainingPercent: number
  resetsAt: string | null
  daysUntilReset: number | null
  elapsedPercent: number | null
  aheadByPercentagePoints: number | null
  averagePercentagePointsPerDay: number | null
  projectedPercentAtReset: number | null
  projectedUnusedPercentAtReset: number | null
  remainingPercentagePointsPerDay: number | null
}

interface ClaudeUsage {
  limits: { kind: string; group: string; percent: number; resets_at: string | null; scope: { model?: { display_name: string } } | null }[]
  seven_day_breakdown?: { window_started_at: string }
  iguana_necktie?: {
    utilization: number; resets_at: string | null
    limit_dollars: number; used_dollars: number; remaining_dollars: number
  } | null
}

interface Window {
  used_percent: number
  limit_window_seconds: number
  reset_at: number
}

interface OpenAIUsage {
  plan_type: string
  rate_limit: { primary_window: Window | null; secondary_window: Window | null } | null
  code_review_rate_limit: OpenAIUsage['rate_limit']
  additional_rate_limits: { limit_name: string; rate_limit: OpenAIUsage['rate_limit'] }[] | null
}

interface DailyUsage {
  units: string
  group_by: string
  data: { date: string; product_surface_usage_values: Record<string, number> }[]
}

interface PlanHistory {
  data_as_of: string
  coverage_start: string
  coverage_complete: boolean
  approximate: boolean
  periods: { starts_at: string; ends_at: string; window_minutes: number; accounting_complete: boolean; used_basis_points: number | null }[]
}

async function request<T>({ page, path, headers = {} }: { page: Page; path: string; headers?: Record<string, string> }) {
  const response = await page.evaluate(async ({ path, headers }) => {
    const res = await fetch(path, { headers, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { status: res.status, body: null }
    return { status: res.status, body: await res.json() as T }
  }, { path, headers }).catch(cause => new UsageError({ reason: `Request failed: ${path}. Check the signed-in browser.`, cause }))
  if (response instanceof Error) return response
  if (response.body === null) return new UsageError({ reason: `HTTP ${response.status}: ${path}. Sign in to ${new URL(page.url()).origin} and retry.` })
  return response.body
}

function weekly({ name, usedPercent, resetsAt, now, startsAt }: {
  name: string; usedPercent: number; resetsAt: string | null; now: number; startsAt?: string
}): WeeklyLimit {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  const start = startsAt ? Date.parse(startsAt) : reset - WEEK
  const valid = Number.isFinite(start) && Number.isFinite(reset) && start < now && now < reset
  const elapsedDays = valid ? (now - start) / DAY : null
  const remainingDays = valid ? (reset - now) / DAY : null
  const elapsedPercent = valid ? (now - start) / WEEK * 100 : null
  const average = elapsedDays === null ? null : usedPercent / elapsedDays
  const projected = average === null || remainingDays === null ? null : usedPercent + average * remainingDays
  return {
    name, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), resetsAt,
    daysUntilReset: remainingDays, elapsedPercent,
    aheadByPercentagePoints: elapsedPercent === null ? null : usedPercent - elapsedPercent,
    averagePercentagePointsPerDay: average,
    projectedPercentAtReset: projected,
    projectedUnusedPercentAtReset: projected === null ? null : Math.max(0, 100 - projected),
    remainingPercentagePointsPerDay: remainingDays === null ? null : (100 - usedPercent) / remainingDays,
  }
}

export async function getClaudeUsage({ page, organizationId }: { page: Page; organizationId?: string }) {
  const organizations = await request<{ uuid: string; capabilities: string[] }[]>({ page, path: '/api/organizations' })
  if (organizations instanceof Error) return organizations
  const eligible = organizations.filter(o => organizationId ? o.uuid === organizationId : o.capabilities.includes('chat'))
  if (eligible.length !== 1) return new UsageError({ reason: 'Specify organizationId: expected one Claude chat organization.' })
  const usage = await request<ClaudeUsage>({ page, path: `/api/organizations/${eligible[0]!.uuid}/usage` })
  if (usage instanceof Error) return usage
  if (!Array.isArray(usage.limits)) return new UsageError({ reason: 'Claude usage schema changed. Inspect the Usage page with Playwriter.' })
  const now = Date.now()
  return {
    checkedAt: new Date(now).toISOString(),
    weekly: usage.limits.filter(l => l.group === 'weekly').map(l => weekly({
      name: l.scope?.model?.display_name ?? l.kind,
      usedPercent: l.percent, resetsAt: l.resets_at, now,
      startsAt: l.kind === 'weekly_all' ? usage.seven_day_breakdown?.window_started_at : undefined,
    })),
    past30Days: null,
    historyUnavailableReason: 'The inspected personal Claude APIs expose current weekly quota and chat counts, not historical quota or token totals.',
    cloudSessionCredits: usage.iguana_necktie ? {
      allowanceDollars: usage.iguana_necktie.limit_dollars,
      usedDollars: usage.iguana_necktie.used_dollars,
      remainingDollars: usage.iguana_necktie.remaining_dollars,
      remainingPercent: Math.max(0, 100 - usage.iguana_necktie.utilization),
      expiresAt: usage.iguana_necktie.resets_at,
      apiKeyEligible: false,
    } : null,
    apiCredits: null,
    apiCreditsUnavailableReason: 'Separate Anthropic API billing is not verified. Cloud-session credits are not an API-key balance.',
  }
}

export async function getOpenAIUsage({ page, accountId }: { page: Page; accountId?: string }) {
  const session = await request<{ accessToken: string; account: { id: string } }>({ page, path: '/api/auth/session' })
  if (session instanceof Error) return session
  if (!session.accessToken || !session.account?.id) return new UsageError({ reason: 'Sign in at chatgpt.com, then retry.' })
  const headers = { authorization: `Bearer ${session.accessToken}`, 'chatgpt-account-id': accountId ?? session.account.id }
  const usage = await request<OpenAIUsage>({ page, path: '/backend-api/wham/usage', headers })
  if (usage instanceof Error) return usage
  const now = Date.now()
  const endDate = new Date(now - DAY).toISOString().slice(0, 10)
  const startDate = new Date(now - 30 * DAY).toISOString().slice(0, 10)
  const [daily, history] = await Promise.all([
    request<DailyUsage>({ page, path: `/backend-api/wham/usage/daily-token-usage-breakdown?start_date=${startDate}&end_date=${endDate}&group_by=day`, headers }),
    request<PlanHistory>({ page, path: '/backend-api/wham/usage/plan_limit_history?days=30', headers }),
  ])
  if (daily instanceof Error) return daily
  if (history instanceof Error) return history
  if (daily.units !== 'percent' || daily.group_by !== 'day' || !Array.isArray(daily.data)) return new UsageError({ reason: 'OpenAI daily usage units changed. Inspect Analytics before computing averages.' })
  const rows = daily.data.filter(d => d.date >= startDate && d.date <= endDate).map(d => ({
    date: d.date,
    percentagePoints: Object.values(d.product_surface_usage_values).reduce((sum, value) => sum + value, 0),
  }))
  const dates = new Set(rows.map(d => d.date))
  const complete = dates.size === 30 && rows.length === 30 && rows.every(d => Number.isFinite(d.percentagePoints))
  const total = rows.reduce((sum, d) => sum + d.percentagePoints, 0)
  const limits = [
    { name: 'Plan', rate_limit: usage.rate_limit },
    { name: 'Code review', rate_limit: usage.code_review_rate_limit },
    ...(usage.additional_rate_limits ?? []).map(l => ({ name: l.limit_name, rate_limit: l.rate_limit })),
  ]
  return {
    checkedAt: new Date(now).toISOString(), plan: usage.plan_type,
    scope: 'Plan limits cover Codex and agentic work. Ordinary ChatGPT conversations are not included in the live weekly meter.',
    weekly: limits.flatMap(l => [l.rate_limit?.primary_window, l.rate_limit?.secondary_window]
      .filter((w): w is Window => w?.limit_window_seconds === WEEK / 1000)
      .map(w => weekly({ name: l.name, usedPercent: w.used_percent, resetsAt: new Date(w.reset_at * 1000).toISOString(), now }))),
    past30Days: {
      startDate, endDate, complete, units: 'percentage points of weekly allowance',
      totalPercentagePoints: total,
      averagePercentagePointsPerDay: complete ? total / 30 : null,
      linearBudgetPercentagePointsPerDay: 100 / 7,
      daily: rows,
    },
    planHistory: {
      dataAsOf: history.data_as_of, coverageStart: history.coverage_start,
      coverageComplete: history.coverage_complete, approximate: history.approximate,
      weeklyPeriods: history.periods.filter(p => p.window_minutes === 10080).map(p => ({
        startsAt: p.starts_at, endsAt: p.ends_at, accountingComplete: p.accounting_complete,
        usedPercent: p.used_basis_points === null ? null : p.used_basis_points / 100,
      })),
    },
  }
}

export async function getSubscriptionUsage(options: { organizationId?: string; accountId?: string } = {}) {
  console.error('Connecting to signed-in Chrome through Playwriter')
  const connection = await connectViaExtension({ tabGroup: 'usage', closeTabsOnEnd: true })
    .catch(cause => new UsageError({ reason: 'Enable the Playwriter extension in Chrome and retry.', cause }))
  if (connection instanceof Error) return connection
  await using browser = connection
  const context = browser.browser.contexts()[0]!
  const read = async (provider: 'claude' | 'openai') => {
    console.error(`Reading ${provider} weekly limits and available history`)
    await using page = await context.newPage()
    await page.goto(provider === 'claude' ? 'https://claude.ai/new' : 'https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return await (provider === 'claude'
      ? getClaudeUsage({ page, organizationId: options.organizationId })
      : getOpenAIUsage({ page, accountId: options.accountId }))
  }
  const [claude, openai] = await Promise.all([
    read('claude').catch(cause => new UsageError({ reason: 'Claude browser request failed. Sign in at claude.ai and retry.', cause })),
    read('openai').catch(cause => new UsageError({ reason: 'OpenAI browser request failed. Sign in at chatgpt.com and retry.', cause })),
  ])
  return { claude, openai }
}

if (import.meta.main) {
  const result = await getSubscriptionUsage()
  if (result instanceof Error) {
    console.error(result.message)
    process.exitCode = 1
  } else {
    const serialize = (value: unknown) => value instanceof Error ? { error: value.message } : value
    console.log(JSON.stringify({ claude: serialize(result.claude), openai: serialize(result.openai) }, null, 2))
    if (result.claude instanceof Error || result.openai instanceof Error) process.exitCode = 1
  }
}
