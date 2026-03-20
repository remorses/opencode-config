<!-- Project memory: persistent implementation notes and gotchas discovered during debugging. -->

# Memory

## Anthropic OAuth plugin

- Working Claude Pro/Max OAuth needs `https://claude.ai/oauth/authorize` and token exchange at `https://platform.claude.com/v1/oauth/token`.
- The working `pi-mono` implementation uses `http://localhost:53692/callback` as the redirect URI and still keeps that same localhost redirect URI even when the user manually pastes back the final callback URL or raw code.
- `pi-mono` is not a separate pure device/code-auth flow for Anthropic. It is a localhost callback flow with a manual fallback path that parses the pasted callback URL or code when the browser cannot reach the local server.
- Anthropic expects `state` in the callback query params; manual fallback should accept the full callback URL, query-string form, or bare code, but still validate `state` when present.
- For OpenCode's Anthropic OAuth requests, the provider fetch path must send Claude Code style headers, including `anthropic-beta: claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14` plus `interleaved-thinking-2025-05-14` on non-adaptive-thinking models, `user-agent: claude-cli/2.1.75`, and `x-app: cli`.
- In this repo, Bun/in-process token exchange and refresh sometimes hit Anthropic 429s while the same request succeeded from a plain Node process. The stable workaround was to run OAuth token and API-key creation HTTP calls through a tiny Node subprocess bridge.
- OpenCode's current plugin auth API cannot do the full `pi-mono` hybrid UX where local callback auto-completes while a manual paste box is also open. The closest remote-first UX is method `code`: always ask for pasted callback URL/code, keep the localhost callback server running in parallel, and accept pasted final callback URLs from remote browsers.
