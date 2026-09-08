# Durable Object memory, OOMs, and invocation errors

The isolate heap limit is **128 MB**. Several objects of one class can share one isolate. Metrics measure the **isolate**, not one object.

An OOM **cannot** be caught. The isolate is killed. Application `try/catch` and `console.error` do not run.

WebSocket close **1006** is only a symptom. Deploys, CPU kills, uncaught throws, and network drops also produce 1006. See `./websocket-close-codes.md`.

## Detect production OOMs

The only OOM signal is invocation status **`exceededMemory`**.

Dashboard path:

**Durable Objects → namespace → Metrics → Errors by invocation status → Exceeded memory limits**

GraphQL dataset: `durableObjectsInvocationsAdaptiveGroups`.

```graphql
query DurableObjectOoms(
  $accountTag: String!
  $namespaceId: String!
  $start: Time!
  $end: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(
        limit: 10000
        filter: {
          namespaceId: $namespaceId
          status: "exceededMemory"
          datetimeSixHours_geq: $start
          datetimeSixHours_leq: $end
        }
      ) {
        sum { errors requests }
        dimensions {
          datetimeSixHours
          objectId
          name
          type
          coloCode
          scriptVersion
        }
      }
    }
  }
}
```

`name` is the Durable Object ID from `idFromName()`. `objectId` is the hex ID. `type` is `http` or `hibernation`.

One isolate reset can count as several `exceededMemory` rows: one per co-located object and one per in-flight invocation type.

HTTP clients can see error **1102**. WebSocket clients see **1006**. Neither proves OOM by itself. Confirm `exceededMemory`.

Do **not** use Logpush `Outcome` as the OOM detector. Trace-event outcomes are only `ok`, `canceled`, `exception`, and `unknown`. OOM is a GraphQL **status**, not a Logpush outcome.

## Split other invocation errors

Count by **status** first. Then split `scriptThrewException` by **message**.

| Status | Dashboard name | Meaning |
|---|---|---|
| `exceededMemory` | Exceeded memory | Isolate hit 128 MB. This is the OOM. |
| `scriptThrewException` | Uncaught Exception | JavaScript threw. Not an OOM. |
| `clientDisconnected` | Cancelled | Client closed before the response finished. |
| `responseStreamDisconnected` | Response Stream Disconnected | The stream or WebSocket died while proxying. |
| `exceededCpu` | Exceeded CPU Time Limits | CPU limit, not memory. |
| `internal` | Internal | Runtime failure. |

Query the same dataset **without** `status: "exceededMemory"`, then group by `status`, `name`, `type`, and `scriptVersion`.

`clientDisconnected` and `responseStreamDisconnected` are transport errors. Do not treat them as application bugs until the same object also shows `scriptThrewException` or `exceededMemory`.

`scriptThrewException` needs stored logs. Metrics do not include exception messages.

### Enable Workers Logs before grouping messages

```jsonc
{
  "upload_source_maps": true,
  "observability": {
    "enabled": true,
    "head_sampling_rate": 0.01
  }
}
```

Deploy, then wait. Logs are kept for **7 days**. There is no history from before the deploy.

Use **1%** sampling on a high-traffic Worker. Full sampling stores every request.

### Group exceptions by message

Workers Observability query:

`POST /accounts/{account_id}/workers/observability/telemetry/query`

Filter `$metadata.service` to the Worker name.

| Goal | Filter | Group by |
|---|---|---|
| Uncaught exceptions | `$workers.outcome` `eq` `exception` | `$metadata.errorTemplate` |
| Any stored error | `$metadata.error` `exists` | `$metadata.errorTemplate` |
| `console.error` | `$metadata.level` `eq` `error` | `$metadata.messageTemplate` |

`$metadata.errorTemplate` collapses IDs and URLs. Use `$metadata.error` for one exact string.

Also group by `$metadata.origin`, `$metadata.trigger`, `$workers.entrypoint`, and `$workers.durableObjectId`.

Live capture without stored logs:

```bash
wrangler tail <worker> -c wrangler.jsonc --format json --status error
```

Read `exceptions[]`. `--search` only matches `console.log` text. It misses uncaught exceptions with no log line.

A caught `console.error` can have `$workers.outcome = "ok"`. That is not `scriptThrewException`.

## Read memory metrics

Dashboard: **Durable Objects → namespace → Metrics → Memory usage**.

GraphQL dataset: `durableObjectsPeriodicGroups`. Percentiles are isolate RSS.

| Percentile | How to read it |
|---|---|
| **P50** | Typical isolate. High while idle means a module-scope baseline. |
| **P90 / P99** | Peaks under load. Near 128 MB means copies, buffering, or concurrency. |
| **P999** | Worst isolates. A few noisy objects can dominate this. |

Production percentiles are not the same as a local heap snapshot.

## Classify the memory pattern

| Pattern | Cause |
|---|---|
| High and flat while idle | Module-scope objects: schema trees, barrels, caches, WASM |
| Growth across requests | Retained Maps, arrays, sockets, or a leak |
| Short peaks | Payload copies, JSON parse, Base64, ignored stream backpressure |

## Profile locally

Profano analyzes **CPU** profiles. It does not analyze heap snapshots.

### Heap snapshots

```bash
wrangler dev
```

Press **D** to open DevTools. Use the **Memory** tab.

1. Take a snapshot after startup, before traffic.
2. Send production-like traffic.
3. Take a second snapshot.
4. Compare retained size and allocation stacks.

Look for `JSON.parse`, `JSON.stringify`, Base64, `ArrayBuffer`, `Map`, and module-scope objects.

Use `v8.getHeapStatistics()`, not `process.memoryUsage()`.

### Bundle baseline

```bash
wrangler deploy --dry-run --outdir dist/worker --metafile dist/worker/meta.json
```

Inspect the exact bundle and the esbuild metafile. Large module-scope imports show up here before they show up as RSS.

The [Polylane writeup](https://x.com/boristane/article/2095611344594555021) used a generated-bundle heap probe to attribute retained MB per module. That method depends on Wrangler’s bundle shape. Prefer snapshots and the metafile unless you are chasing a high idle baseline.

## Optimize

- Keep JSON Schema as plain objects when JSON Schema is the output. Do not retain Zod trees at module scope.
- Replace `export *` barrels with named exports.
- Replace package-root dynamic imports with static named imports when the import is required.
- Stream request and response bodies. Do not `arrayBuffer()` a large body, then Base64 it, then `JSON.stringify` it.
- Bound Maps, queues, pending-request tables, and caches.
- Await `WritableStreamDefaultWriter.write()`. Do not ignore backpressure with `void writer.write(...)`.
- Store durable state in DO storage so the isolate can hibernate.
- Drop oversized WebSocket frames before `JSON.parse`.

## Verify

Compare **before and after the deployment marker**:

1. `exceededMemory` count
2. P50 and P99 memory
3. Heap snapshots under the same workload

Retries and WebSocket reconnects are not a memory fix.

Docs:

- https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/
- https://developers.cloudflare.com/analytics/graphql-api/
