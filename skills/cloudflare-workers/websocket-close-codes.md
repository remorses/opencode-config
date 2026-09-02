## WebSocket close codes on Durable Objects

**1006** means the TCP socket died with **no Close frame**. Cloudflare never sends 1006. The client invents it.

Isolate kill from **OOM**, **CPU**, uncaught throws, deploys, and host moves happens often. Always **reopen** the WebSocket. Do not treat 1006 as a fatal app error.

Hibernation does **not** drop sockets. Shutdown **does**.

Docs: [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [Error 1102](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/), [MDN close codes](https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code).

```
  client A ──► ┌──────────────┐ ◄── client B
               │  DO isolate  │
               │  128 MB heap │
               └──────┬───────┘
                      │
         OOM / CPU / throw / deploy / host move
                      │
                      ▼
               isolate gone
               no Close frame
               both clients see 1006
                      │
                      ▼
               reopen WebSocket
```

### Always reconnect

Reconnect with backoff and jitter on these codes. They are **transient**:

| Code | Meaning | Why reopen |
| --- | --- | --- |
| **1006** | Abnormal closure. No close frame | Isolate died, network blip, CDN drop. Error **1101** / **1102** look like this |
| **1001** | Going away | Deploy or host move if a frame is sent |
| **1011** | Internal error | `webSocketError`, failed `send()`, server bug |
| **1012** | Service restart | App or spec: peer restarted. Reopen |
| **1013** | Try again later | Backoff longer, then reopen |

Do **not** wait for a nicer code. Cloudflare does **not** map isolate kill to a WebSocket status. Clients see **1006**.

```ts
const RECONNECT_CODES = new Set([1001, 1006, 1011, 1012, 1013])

function shouldReconnectWebSocket(code: number): boolean {
  if (RECONNECT_CODES.has(code)) {
    return true
  }
  // Unknown 4xxx from your app: reopen unless you know it is auth or fatal.
  if (code >= 4000 && code < 5000) {
    return true
  }
  return false
}

function reconnectDelayMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt)
  return base + Math.floor(Math.random() * 400)
}

socket.addEventListener('close', (event) => {
  if (!shouldReconnectWebSocket(event.code)) {
    return
  }
  setTimeout(() => {
    openSocket()
  }, reconnectDelayMs(attempt))
})
```

Ping every **30s**. Cloudflare can idle-drop around **100s** on Free/Pro. Protocol pings do not wake a hibernated DO.

### Do not treat as fatal

| Code | Meaning | Action |
| --- | --- | --- |
| **1000** | Normal close | Reopen only if the user still wants the session |
| **1009** | Message too large (received **32 MiB**) | Reopen the socket. Do **not** resend the same payload |
| **4409** and similar "already in use" | Your app rejected a second upstream | Slow retry if the old socket may be stale. Then give up |

Codes **4000–4999** are application-specific, not Cloudflare. You define their meaning. Example: no upstream yet. Retry, but **wait** for the peer. Immediate retry races the reconnect.

### Isolate kill vs hibernation

**Hibernation** (idle ~10s, hibernation API): clients stay connected. In-memory class fields are wiped. Restore per-socket state with `serializeAttachment` / `deserializeAttachment`.

**Shutdown** (deploy, runtime update, host move, eviction): sockets are **terminated**. Clients see **1006**. There is no shutdown hook.

`setTimeout`, in-flight `fetch()`, and the standard WebSocket API **block hibernation**. The DO then sits in memory and can be **evicted** after 70–140s idle, which also drops sockets.

### Limits that produce 1006

- Isolate memory **128 MB**. JSON parse + stringify of one large frame can OOM before the **32 MiB** WS cap.
- Error **1102**: exceeded CPU or memory. HTTP clients get 1102. WebSocket clients get **1006**.
- Error **1101**: uncaught JavaScript exception. Same **1006** on every attached socket.
- Wrap `webSocketMessage` in try/catch. Close **that** socket with **1011**. Do not let one throw kill the isolate.

Do not confuse this with Cloudflare HTTP **Error 1006** (IP banned). That is a different 1006.

https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1006/
