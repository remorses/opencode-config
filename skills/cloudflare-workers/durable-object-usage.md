# Durable Object usage and spend per project

Find which Worker's Durable Objects cost money, and check that idle WebSocket DOs really hibernate. Works when account credits hide the bill: it reads **usage**, not invoices.

```
GraphQL Analytics API
  durableObjectsInvocationsAdaptiveGroups ──▶ requests per scriptName + namespaceId
  durableObjectsPeriodicGroups            ──▶ activeTime (duration), WS messages per namespaceId / objectId
                                                │
                                                └──▶ cost = list price × usage (estimate)
```

## Auth

`cf` has no GraphQL command. Reuse its OAuth token with curl (needs `account-analytics.read`, which `cf auth login` grants by default):

```bash
TOKEN=$(jq -r .oauth_token ~/Library/Preferences/cloudflare/config/default.json)   # macOS path
ACCOUNT=$(cf auth whoami | jq -r '.accounts[0].id')
gql() { # usage: gql "$QUERY" '{"s":"2026-10-01","e":"2026-10-20"}'
  curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg q "$1" --arg a "$ACCOUNT" --argjson v "$2" '{query:$q,variables:($v+{a:$a})}')"
}
```

If the token expired, run any `cf` command first (it refreshes) or `cf auth login`.

## 1. Duration and requests per namespace

`activeTime` is in **microseconds**. `periodic` groups have only `namespaceId`; `invocations` groups map it to `scriptName`.

```bash
Q='query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
  per: durableObjectsPeriodicGroups(limit:100,filter:{date_geq:$s,date_leq:$e},orderBy:[sum_activeTime_DESC]){
    sum{activeTime cpuTime inboundWebsocketMsgCount outboundWebsocketMsgCount} dimensions{namespaceId}}
  inv: durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{date_geq:$s,date_leq:$e},orderBy:[sum_requests_DESC]){
    sum{requests} dimensions{namespaceId scriptName}}
}}}'
gql "$Q" '{"s":"2026-10-01","e":"2026-10-20"}' > /tmp/do.json
jq -r '.data.viewer.accounts[0] as $r
  | ($r.inv | map({(.dimensions.namespaceId): .dimensions.scriptName}) | add) as $names
  | $r.per[] | [($names[.dimensions.namespaceId] // .dimensions.namespaceId),
     (.sum.activeTime/1e6/3600|floor|tostring+" h"),
     ((.sum.activeTime/1e6*0.128*12.5/1e6*100|floor)/100|tostring+" $"),
     .sum.inboundWebsocketMsgCount] | @tsv' /tmp/do.json
```

## 2. Estimate cost

Paid plan list prices (https://developers.cloudflare.com/durable-objects/platform/pricing/):

| metric | formula | included per month |
|---|---|---|
| Duration | `activeTime_s × 0.128 GB × $12.50 / 1M` | 400k GB-s |
| Requests | `requests × $0.15 / 1M` (inbound WS messages count 20:1) | 1M |

Rule of thumb: **one DO awake 24/7 ≈ $3.40/month** in duration alone. `activeTime_hours / hours_in_range` = average number of DOs always awake.

## 3. Check that WebSocket DOs hibernate

Per object, for one namespace. A hibernating WebSocket DO has small `activeTime` even with long-lived connections.

```bash
Q='query($a:String!,$s:Date!,$e:Date!,$n:String!){viewer{accounts(filter:{accountTag:$a}){
  obj: durableObjectsPeriodicGroups(limit:15,filter:{date_geq:$s,date_leq:$e,namespaceId:$n},orderBy:[sum_activeTime_DESC]){
    sum{activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount} dimensions{objectId}}
}}}'
gql "$Q" '{"s":"2026-10-01","e":"2026-10-20","n":"<namespaceId>"}' \
  | jq -r '.data.viewer.accounts[0].obj[] | [.dimensions.objectId[0:12], (.sum.activeTime/1e6/3600|floor), .sum.inboundWebsocketMsgCount] | @tsv'
```

**Red flag:** `inboundWebsocketMsgCount / active_hours` is a steady few hundred (for example ~650/h = one message every ~5s) on objects active hundreds of hours. That is an app-level keepalive waking the DO, so it never hibernates. Fix: see "Durable Object duration: keepalives" in SKILL.md.

Add `date` to `dimensions` (and `orderBy:[date_ASC]`) for a per-day trend, to confirm a fix after deploy. Data lags a few minutes; compare full days.
