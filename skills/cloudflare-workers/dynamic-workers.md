
## Dynamic Workers (`worker_loaders`)

Dynamic Workers let you spin up isolated Workers at runtime from code strings. Requires `worker_loaders` binding in wrangler.jsonc and **wrangler >= 4.86.0** (older versions crash with error 1101 at runtime).

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

### Key constraints

- **Modules must be `.js` or `.py`** — passing CSS, JSON, or WASM files in the `modules` map causes `TypeError: Module name must end with '.js' or '.py'`. Filter non-JS files before passing to `env.LOADER.get()`.
- **No platform static assets** — Dynamic Workers don't have access to Workers Static Assets (`assets.directory`). Serve static files from the parent worker (via KV or R2) before forwarding to the Dynamic Worker.
- **No direct D1/KV/R2** — Dynamic Workers can't receive raw Cloudflare bindings. Wrap resources as `WorkerEntrypoint` classes and pass stubs via `env`. See [Bindings docs](https://developers.cloudflare.com/dynamic-workers/usage/bindings/).
- **`@cloudflare/vite-plugin` builds don't export `default { fetch }`** — The platform wraps the worker entry at deploy time. Dynamic Workers need a wrapper module:

```ts
const wrapperJs = `
  import { fetchHandler } from "./ssr/index.js";
  export default {
    async fetch(request, env, ctx) {
      return fetchHandler(request, env, ctx);
    }
  };
`

const worker = env.LOADER.get(id, async () => ({
  compatibilityDate: '2026-05-11',
  compatibilityFlags: ['nodejs_compat'],
  mainModule: '__entry.js',
  modules: { '__entry.js': wrapperJs, ...userModules },
}))

return worker.getEntrypoint().fetch(request)
```

- **RSC + SSR are separate module trees** — `dist/rsc/ssr/index.js` imports `../index.js` (the RSC entry). Upload both `dist/rsc/ssr/` AND `dist/rsc/` root files, preserving the directory structure so relative imports resolve.
