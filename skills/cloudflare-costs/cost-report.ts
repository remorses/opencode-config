// Estimate Cloudflare spend per project from usage analytics (GraphQL) + list prices.
// Works when account credits hide the invoice. Run: bun cost-report.ts [--from 2026-10-01] [--to 2026-10-20] [--json]

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const API = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 30_000
const DO_MEMORY_GB = 0.128
const DO_WS_MESSAGE_RATIO = 20

// Paid plan list prices, USD per unit. https://developers.cloudflare.com/workers/platform/pricing/
const PRICE = {
  workerRequest: 0.3 / 1e6,
  workerCpuMs: 0.02 / 1e6,
  doRequest: 0.15 / 1e6,
  doGbSecond: 12.5 / 1e6,
  doRowWritten: 1 / 1e6,
  kvRead: 0.5 / 1e6,
  kvWrite: 5 / 1e6,
  kvGbMonth: 0.5,
  r2GbMonth: 0.015,
  r2ClassA: 4.5 / 1e6,
  r2ClassB: 0.36 / 1e6,
  d1RowRead: 0.001 / 1e6,
  d1RowWritten: 1 / 1e6,
  d1GbMonth: 0.75,
  aiNeuron: 0.011 / 1000,
}

// Monthly included amounts, subtracted once at account level.
const INCLUDED = {
  workerRequest: 10e6,
  workerCpuMs: 30e6,
  doRequest: 1e6,
  doGbSecond: 400e3,
  doRowWritten: 50e6,
  kvRead: 10e6,
  kvWrite: 1e6,
  kvGbMonth: 1,
  r2GbMonth: 10,
  r2ClassA: 1e6,
  r2ClassB: 10e6,
  d1RowRead: 25e9,
  d1RowWritten: 50e6,
  d1GbMonth: 5,
  aiNeuronPerDay: 10_000,
}

type Metric = keyof typeof PRICE
type Usage = Partial<Record<Metric, number>>

const R2_CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload',
  'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart',
  'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
])
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'])
// Monthly storage metrics: not scaled when projecting to a full month.
const STORAGE_METRICS = new Set<Metric>(['kvGbMonth', 'r2GbMonth', 'd1GbMonth'])

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const now = new Date()
  const from = get('--from') ?? `${now.toISOString().slice(0, 7)}-01`
  const to = get('--to') ?? now.toISOString().slice(0, 10)
  return { from, to, json: args.includes('--json') }
}

async function getAuth() {
  // `cf auth whoami` refreshes the OAuth token when it expired.
  const { stdout } = await execFileAsync('cf', ['auth', 'whoami'], { timeout: REQUEST_TIMEOUT_MS })
  const whoami = JSON.parse(stdout)
  const config = JSON.parse(
    await readFile(join(homedir(), 'Library/Preferences/cloudflare/config/default.json'), 'utf8'),
  )
  return { token: config.oauth_token as string, accountId: whoami.accounts[0].id as string }
}

async function cfFetch({ token, path, body }: { token: string; path: string; body?: unknown }) {
  const response = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return response.json() as Promise<any>
}

async function graphql({ token, accountId, from, to, fields }: { token: string; accountId: string; from: string; to: string; fields: string }) {
  const query = `query($a:String!,$s:Date!,$e:Date!,$st:Time!,$et:Time!){viewer{accounts(filter:{accountTag:$a}){${fields}}}}`
  const variables = { a: accountId, s: from, e: to, st: `${from}T00:00:00Z`, et: `${to}T23:59:59Z` }
  const result = await cfFetch({ token, path: '/graphql', body: { query, variables } })
  if (result.errors?.length) {
    throw new Error(`GraphQL: ${result.errors.map((error: any) => error.message).join('; ')}`)
  }
  return result.data.viewer.accounts[0]
}

// Groups preview/production variants of one Worker into one project.
function projectOf(script: string) {
  return script.replace(/-(preview|production|staging)$/, '')
}

// Average of the daily max: monthly storage is billed on the average stored size.
function averageDailyMax({ rows, key, value }: { rows: any[]; key: (row: any) => string; value: (row: any) => number }) {
  const days = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const id = key(row)
    const perDay = days.get(id) ?? new Map<string, number>()
    perDay.set(row.dimensions.date, Math.max(perDay.get(row.dimensions.date) ?? 0, value(row)))
    days.set(id, perDay)
  }
  const result = new Map<string, number>()
  for (const [id, perDay] of days) {
    const values = [...perDay.values()]
    result.set(id, values.reduce((sum, v) => sum + v, 0) / values.length)
  }
  return result
}

async function main() {
  const { from, to, json } = parseArgs()
  const { token, accountId } = await getAuth()
  console.error(`[cost] account ${accountId}, range ${from}..${to}`)

  console.error('[cost] reading Worker bindings')
  const scripts: any[] = (await cfFetch({ token, path: `/accounts/${accountId}/workers/scripts` })).result ?? []
  const owners = new Map<string, Set<string>>() // resource key -> projects
  const addOwner = (resource: string, script: string) => {
    const set = owners.get(resource) ?? new Set<string>()
    set.add(projectOf(script))
    owners.set(resource, set)
  }
  await Promise.all(
    scripts.map(async (script) => {
      const settings = await cfFetch({ token, path: `/accounts/${accountId}/workers/scripts/${script.id}/settings` })
      for (const binding of settings.result?.bindings ?? []) {
        if (binding.type === 'kv_namespace') addOwner(`kv:${binding.namespace_id}`, script.id)
        if (binding.type === 'r2_bucket') addOwner(`r2:${binding.bucket_name}`, script.id)
        if (binding.type === 'd1') addOwner(`d1:${binding.id}`, script.id)
      }
    }),
  )

  console.error('[cost] querying usage analytics')
  const data = await graphql({
    token, accountId, from, to,
    fields: `
      w: workersInvocationsAdaptive(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests cpuTimeUs} dimensions{scriptName}}
      di: durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{namespaceId scriptName type}}
      dp: durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{activeTime rowsWritten} dimensions{namespaceId}}
      ko: kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{namespaceId actionType}}
      ks: kvStorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){max{byteCount} dimensions{namespaceId date}}
      rs: r2StorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){max{payloadSize metadataSize} dimensions{bucketName date}}
      ro: r2OperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{bucketName actionType}}
      dq: d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{rowsRead rowsWritten} dimensions{databaseId}}
      ds: d1StorageAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){max{databaseSizeBytes} dimensions{databaseId date}}
      ai: aiInferenceAdaptiveGroups(limit:10000,filter:{datetime_geq:$st,datetime_leq:$et}){sum{totalNeurons}}
    `,
  })

  const usage = new Map<string, Usage>()
  const add = ({ project, metric, amount }: { project: string; metric: Metric; amount: number }) => {
    const row = usage.get(project) ?? {}
    row[metric] = (row[metric] ?? 0) + amount
    usage.set(project, row)
  }
  // Shared resources are split evenly between the projects that bind them.
  const addResource = ({ resource, label, metric, amount }: { resource: string; label: string; metric: Metric; amount: number }) => {
    const projects = [...(owners.get(resource) ?? [`(unbound) ${label}`])]
    for (const project of projects) add({ project, metric, amount: amount / projects.length })
  }

  for (const row of data.w) {
    add({ project: projectOf(row.dimensions.scriptName), metric: 'workerRequest', amount: row.sum.requests })
    add({ project: projectOf(row.dimensions.scriptName), metric: 'workerCpuMs', amount: row.sum.cpuTimeUs / 1000 })
  }
  const namespaceScript = new Map<string, string>()
  for (const row of data.di) {
    namespaceScript.set(row.dimensions.namespaceId, row.dimensions.scriptName)
    // `hibernation` invocations are incoming WebSocket messages, billed 20:1.
    const ratio = row.dimensions.type === 'hibernation' ? DO_WS_MESSAGE_RATIO : 1
    add({ project: projectOf(row.dimensions.scriptName), metric: 'doRequest', amount: row.sum.requests / ratio })
  }
  for (const row of data.dp) {
    const script = namespaceScript.get(row.dimensions.namespaceId) ?? `(do) ${row.dimensions.namespaceId.slice(0, 8)}`
    add({ project: projectOf(script), metric: 'doGbSecond', amount: (row.sum.activeTime / 1e6) * DO_MEMORY_GB })
    add({ project: projectOf(script), metric: 'doRowWritten', amount: row.sum.rowsWritten })
  }
  for (const row of data.ko) {
    const id = row.dimensions.namespaceId
    const metric: Metric = row.dimensions.actionType === 'read' ? 'kvRead' : 'kvWrite'
    addResource({ resource: `kv:${id}`, label: `kv ${id.slice(0, 8)}`, metric, amount: row.sum.requests })
  }
  for (const [id, bytes] of averageDailyMax({ rows: data.ks, key: (row) => row.dimensions.namespaceId.replaceAll('-', ''), value: (row) => row.max.byteCount })) {
    addResource({ resource: `kv:${id}`, label: `kv ${id.slice(0, 8)}`, metric: 'kvGbMonth', amount: bytes / 1e9 })
  }
  for (const [bucket, bytes] of averageDailyMax({ rows: data.rs, key: (row) => row.dimensions.bucketName, value: (row) => row.max.payloadSize + row.max.metadataSize })) {
    addResource({ resource: `r2:${bucket}`, label: `r2 ${bucket}`, metric: 'r2GbMonth', amount: bytes / 1e9 })
  }
  for (const row of data.ro) {
    const action = row.dimensions.actionType
    if (R2_FREE.has(action)) continue
    const metric: Metric = R2_CLASS_A.has(action) ? 'r2ClassA' : 'r2ClassB'
    addResource({ resource: `r2:${row.dimensions.bucketName}`, label: `r2 ${row.dimensions.bucketName}`, metric, amount: row.sum.requests })
  }
  for (const row of data.dq) {
    const id = row.dimensions.databaseId
    addResource({ resource: `d1:${id}`, label: `d1 ${id.slice(0, 8)}`, metric: 'd1RowRead', amount: row.sum.rowsRead })
    addResource({ resource: `d1:${id}`, label: `d1 ${id.slice(0, 8)}`, metric: 'd1RowWritten', amount: row.sum.rowsWritten })
  }
  for (const [id, bytes] of averageDailyMax({ rows: data.ds, key: (row) => row.dimensions.databaseId, value: (row) => row.max.databaseSizeBytes })) {
    addResource({ resource: `d1:${id}`, label: `d1 ${id.slice(0, 8)}`, metric: 'd1GbMonth', amount: bytes / 1e9 })
  }
  const neurons = data.ai.reduce((sum: number, row: any) => sum + row.sum.totalNeurons, 0)
  add({ project: '(account) Workers AI', metric: 'aiNeuron', amount: neurons })

  // Project the range to a full calendar month. Storage metrics are already monthly.
  const fromDate = new Date(`${from}T00:00:00Z`)
  const rangeDays = (new Date(`${to}T00:00:00Z`).getTime() - fromDate.getTime()) / 86_400_000 + 1
  const monthDays = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth() + 1, 0)).getUTCDate()
  const scale = monthDays / rangeDays

  const rows = [...usage.entries()].map(([project, metrics]) => {
    const cost = Object.fromEntries(
      Object.entries(metrics).map(([metric, amount]) => {
        const factor = STORAGE_METRICS.has(metric as Metric) ? 1 : scale
        return [metric, amount * PRICE[metric as Metric] * factor]
      }),
    ) as Partial<Record<Metric, number>>
    const total = Object.values(cost).reduce((sum, value) => sum + (value ?? 0), 0)
    return { project, usage: metrics, monthCost: cost, monthTotal: total }
  }).sort((a, b) => b.monthTotal - a.monthTotal)

  const gross = rows.reduce((sum, row) => sum + row.monthTotal, 0)
  const included = (Object.keys(PRICE) as Metric[]).reduce((sum, metric) => {
    const used = rows.reduce((acc, row) => acc + (row.usage[metric] ?? 0), 0) * (STORAGE_METRICS.has(metric) ? 1 : scale)
    const free = metric === 'aiNeuron' ? INCLUDED.aiNeuronPerDay * monthDays : INCLUDED[metric as keyof typeof INCLUDED]
    return sum + Math.min(used, free) * PRICE[metric]
  }, 0)

  if (json) {
    console.log(JSON.stringify({ from, to, scale, gross, included, net: gross - included, rows }, null, 2))
    return
  }
  const usd = (value: number) => `$${value.toFixed(2)}`
  const top = (row: (typeof rows)[number]) =>
    Object.entries(row.monthCost).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, 2)
      .filter(([, value]) => (value ?? 0) >= 0.5).map(([metric, value]) => `${metric} ${usd(value ?? 0)}`).join(', ')
  console.log(`Estimated month cost (${from}..${to}, scaled x${scale.toFixed(2)}, list prices)\n`)
  console.log('| project | est. month | main drivers |\n|---|---|---|')
  for (const row of rows.filter((row) => row.monthTotal >= 0.5)) {
    console.log(`| ${row.project} | ${usd(row.monthTotal)} | ${top(row)} |`)
  }
  console.log(`\nGross ${usd(gross)}, included free tier -${usd(included)}, **net ~${usd(gross - included)}/month**`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
