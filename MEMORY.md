<!-- Project memory: persistent implementation notes and gotchas discovered during debugging. -->

# Memory

## Anthropic OAuth plugin

- In this setup, the active OpenCode Anthropic plugin is a wrapper at `plugins/anthropic-auth.ts` that imports `kimakivoice/discord/src/anthropic-auth-plugin.ts`. Changes to Anthropic OAuth behavior should usually go in the Kimaki repo plugin, not the stale copy under `disabled-plugins/anthropic-auth.ts`.
- For Anthropic multi-account UX, adding a new account should happen through the normal login flow with a different Claude account. Management commands should stay minimal and focus on listing and removing stored accounts instead of a separate `add` command.
- Anthropic multi-account state now uses a separate XDG/home-based store file (`anthropic-oauth-accounts.json`) while `auth.json` keeps only the currently active `anthropic` credential. Normal OAuth login implicitly enrolls the account into that pool.
- Working Claude Pro/Max OAuth needs `https://claude.ai/oauth/authorize` and token exchange at `https://platform.claude.com/v1/oauth/token`.
- The working `pi-mono` implementation uses `http://localhost:53692/callback` as the redirect URI and still keeps that same localhost redirect URI even when the user manually pastes back the final callback URL or raw code.
- `pi-mono` is not a separate pure device/code-auth flow for Anthropic. It is a localhost callback flow with a manual fallback path that parses the pasted callback URL or code when the browser cannot reach the local server.
- Anthropic expects `state` in the callback query params; manual fallback should accept the full callback URL, query-string form, or bare code, but still validate `state` when present.
- For OpenCode's Anthropic OAuth requests, the provider fetch path must send Claude Code style headers, including `anthropic-beta: claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14` plus `interleaved-thinking-2025-05-14` on non-adaptive-thinking models, `user-agent: claude-cli/2.1.75`, and `x-app: cli`.
- In this repo, Bun/in-process token exchange and refresh sometimes hit Anthropic 429s while the same request succeeded from a plain Node process. The stable workaround was to run OAuth token and API-key creation HTTP calls through a tiny Node subprocess bridge.
- OpenCode's current plugin auth API cannot do the full `pi-mono` hybrid UX where local callback auto-completes while a manual paste box is also open. In this repo, `process.env.KIMAKI` enables the remote-first `code` flow (paste callback URL/code), while non-Kimaki runs use the normal `auto` localhost-complete flow.
