/**
 * Anthropic OAuth authentication plugin for OpenCode.
 *
 * Enables Claude Pro/Max OAuth login and adds required beta headers:
 * - oauth-2025-04-20: OAuth authentication
 * - interleaved-thinking-2025-05-14: Native reasoning between tool calls
 * - context-1m-2025-08-07: 1 million token context window (Opus 4.6 beta)
 *
 * Also handles:
 * - Token refresh when expired
 * - System prompt sanitization (OpenCode -> Claude Code)
 * - Tool name prefixing (mcp_) for compatibility
 * - Configurable Anthropic User-Agent for OAuth/API requests
 * - Zero cost display for OAuth users (Pro/Max plan)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { createServer, type Server } from "node:http";
import { generatePKCE } from "@openauthjs/openauth/pkce";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_CALLBACK_PORT = 50751;
const OAUTH_CALLBACK_PATH = "/callback";
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const DEFAULT_ANTHROPIC_USER_AGENT = "claude-code/2.1.80";
const ANTHROPIC_HOSTS = new Set([
  "api.anthropic.com",
  "console.anthropic.com",
  "claude.ai",
  "platform.claude.com",
]);
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

type CallbackResult = {
  code: string;
  state: string;
};

type CallbackServerInfo = {
  server: Server;
  redirectUri: string;
  cancelWait: () => void;
  waitForCode: () => Promise<CallbackResult | null>;
};

function getAnthropicUserAgent() {
  return process.env.OPENCODE_ANTHROPIC_USER_AGENT || DEFAULT_ANTHROPIC_USER_AGENT;
}

function resolveUrl(input: Request | string | URL) {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input.toString());
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
  } catch {
    // ignore URL parse errors
  }
  return null;
}

function buildHeaders(input: Request | string | URL, init?: RequestInit) {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (init?.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (Array.isArray(init?.headers)) {
    for (const [key, value] of init.headers as [string, string][]) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  } else if (init?.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  }

  return headers;
}

async function anthropicFetch(input: Request | string | URL, init?: RequestInit) {
  const url = resolveUrl(input);
  if (!url || !ANTHROPIC_HOSTS.has(url.hostname)) {
    return fetch(input, init);
  }

  const headers = buildHeaders(input, init);
  const incomingBeta = headers.get("anthropic-beta") || "";
  const mergedBetas = [
    ...new Set([
      OAUTH_BETA,
      ...incomingBeta
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ].join(",");

  headers.set("anthropic-beta", mergedBetas);
  headers.set("user-agent", getAnthropicUserAgent());

  return fetch(input, {
    ...(init ?? {}),
    headers,
  });
}

type OAuthStored = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
};

type OAuthSuccess = {
  type: "success";
  provider?: string;
  refresh: string;
  access: string;
  expires: number;
};

type ApiKeySuccess = {
  type: "success";
  provider?: string;
  key: string;
};

type FailedResult = {
  type: "failed";
};

type AuthResult = OAuthSuccess | ApiKeySuccess | FailedResult;

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
  return new Promise((resolve, reject) => {
    let settleWait: ((value: CallbackResult | null) => void) | undefined;
    const waitForCodePromise = new Promise<CallbackResult | null>((resolveWait) => {
      let settled = false;
      settleWait = (value) => {
        if (settled) return;
        settled = true;
        resolveWait(value);
      };
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", OAUTH_REDIRECT_URI);
        if (url.pathname !== OAUTH_CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("OAuth callback route not found.");
          return;
        }

        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Anthropic authentication failed: ${error}`);
          settleWait?.(null);
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing code or state parameter.");
          settleWait?.(null);
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("OAuth state mismatch.");
          settleWait?.(null);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Anthropic authentication completed. You can close this window.");
        settleWait?.({ code, state });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal OAuth callback error.");
        settleWait?.(null);
      }
    });

    server.once("error", reject);
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      resolve({
        server,
        redirectUri: OAUTH_REDIRECT_URI,
        cancelWait: () => settleWait?.(null),
        waitForCode: () => waitForCodePromise,
      });
    });
  });
}

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE();
  const callbackServer = await startCallbackServer(pkce.verifier);

  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackServer.redirectUri);
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    callbackServer,
  };
}

async function exchange(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthSuccess | FailedResult> {
  if (state !== verifier) {
    console.error("[anthropic-auth] OAuth state mismatch in callback");
    return { type: "failed" };
  }

  const result = await anthropicFetch("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!result.ok) {
    const details = await result.text().catch(() => "");
    console.error(
      `[anthropic-auth] Token exchange failed: ${result.status} ${result.statusText}${details ? ` - ${details}` : ""}`,
    );
    return { type: "failed" };
  }
  const json = (await result.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
  };
}

const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
    "experimental.chat.system.transform": async (
      input: { model?: { providerID?: string } },
      output: { system: string[] },
    ) => {
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1]) {
          output.system[1] = prefix + "\n\n" + output.system[1];
        }
      }
    },
    auth: {
      provider: "anthropic",
      async loader(
        getAuth: () => Promise<OAuthStored | { type: string }>,
        provider: { models: Record<string, { cost?: unknown }> },
      ) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // Zero out cost display for Pro/Max plan users
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }
          return {
            apiKey: "",
            async fetch(input: Request | string | URL, init?: RequestInit) {
              const auth = (await getAuth()) as OAuthStored;
              if (auth.type !== "oauth") return fetch(input, init);

              // Refresh token if expired
              if (!auth.access || auth.expires < Date.now()) {
                const response = await anthropicFetch(
                  "https://platform.claude.com/v1/oauth/token",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      grant_type: "refresh_token",
                      refresh_token: auth.refresh,
                      client_id: CLIENT_ID,
                    }),
                  },
                );
                if (!response.ok) {
                  throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
                }
                const json = (await response.json()) as {
                  refresh_token: string;
                  access_token: string;
                  expires_in: number;
                };
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
                  },
                });
                auth.access = json.access_token;
              }

              const requestInit = init ?? {};

              // Build headers
              const requestHeaders = buildHeaders(input, requestInit);

              // Merge beta headers - preserve incoming + add required ones
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const requiredBetas = [
                OAUTH_BETA,
                "interleaved-thinking-2025-05-14",
                // "context-1m-2025-08-07", // 1M context window for Opus 4.6
              ];
              const mergedBetas = [
                ...new Set([...requiredBetas, ...incomingBetasList]),
              ].join(",");

              requestHeaders.set("authorization", `Bearer ${auth.access}`);
              requestHeaders.set("anthropic-beta", mergedBetas);
              requestHeaders.set(
                "user-agent",
                getAnthropicUserAgent(),
              );
              requestHeaders.delete("x-api-key");

              // Transform request body
              const TOOL_PREFIX = "mcp_";
              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt - server blocks "You are OpenCode" string
                  // Only replace this specific string, not all OpenCode references
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map(
                      (item: { type?: string; text?: string }) => {
                        if (item.type === "text" && item.text) {
                          return {
                            ...item,
                            text: item.text.replace(
                              "You are OpenCode, the best coding agent on the planet.",
                              "You are Claude Code, Anthropic's official CLI for Claude.",
                            ),
                          };
                        }
                        return item;
                      },
                    );
                  }

                  // Add prefix to tools definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map(
                      (tool: { name?: string }) => ({
                        ...tool,
                        name: tool.name
                          ? `${TOOL_PREFIX}${tool.name}`
                          : tool.name,
                      }),
                    );
                  }

                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map(
                      (msg: { content?: Array<{ type?: string; name?: string }> }) => {
                        if (msg.content && Array.isArray(msg.content)) {
                          msg.content = msg.content.map((block) => {
                            if (block.type === "tool_use" && block.name) {
                              return {
                                ...block,
                                name: `${TOOL_PREFIX}${block.name}`,
                              };
                            }
                            return block;
                          });
                        }
                        return msg;
                      },
                    );
                  }
                  body = JSON.stringify(parsed);
                } catch {
                  // ignore parse errors
                }
              }

              // Add ?beta=true to /v1/messages endpoint
              let requestInput: Request | string | URL = input;
              let requestUrl: URL | null = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const response = await anthropicFetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Transform streaming response to rename tools back (remove mcp_ prefix)
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        return {};
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier, callbackServer } = await authorize("max");
            return {
              url,
              instructions: "Complete login in your browser. The localhost callback will finish automatically.",
              method: "auto",
              callback: async (): Promise<AuthResult> => {
                try {
                  const result = await Promise.race([
                    callbackServer.waitForCode(),
                    new Promise<null>((resolve) => {
                      setTimeout(() => resolve(null), OAUTH_TIMEOUT_MS);
                    }),
                  ]);

                  if (!result) {
                    console.error("[anthropic-auth] Timed out waiting for localhost OAuth callback");
                    return { type: "failed" };
                  }

                  return exchange(result.code, result.state, verifier, callbackServer.redirectUri);
                } finally {
                  callbackServer.cancelWait();
                  await closeServer(callbackServer.server);
                }
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier, callbackServer } = await authorize("console");
            return {
              url,
              instructions: "Complete login in your browser. The localhost callback will finish automatically.",
              method: "auto",
              callback: async (): Promise<AuthResult> => {
                try {
                  const result = await Promise.race([
                    callbackServer.waitForCode(),
                    new Promise<null>((resolve) => {
                      setTimeout(() => resolve(null), OAUTH_TIMEOUT_MS);
                    }),
                  ]);

                  if (!result) {
                    console.error("[anthropic-auth] Timed out waiting for localhost OAuth callback");
                    return { type: "failed" };
                  }

                  const credentials = await exchange(
                    result.code,
                    result.state,
                    verifier,
                    callbackServer.redirectUri,
                  );
                  if (credentials.type === "failed") return credentials;
                  const apiKeyResult = await anthropicFetch(
                    `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        authorization: `Bearer ${credentials.access}`,
                      },
                    },
                  ).then((r) => r.json() as Promise<{ raw_key: string }>);
                  return { type: "success", key: apiKeyResult.raw_key };
                } finally {
                  callbackServer.cancelWait();
                  await closeServer(callbackServer.server);
                }
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
};

export { AnthropicAuthPlugin };
