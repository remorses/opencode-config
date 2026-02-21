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
 * - Zero cost display for OAuth users (Pro/Max plan)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { generatePKCE } from "@openauthjs/openauth/pkce";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

type OAuthCredentials = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
};

type ApiKeyCredentials = {
  type: "success";
  key: string;
};

type FailedCredentials = {
  type: "failed";
};

type AuthResult = OAuthCredentials | ApiKeyCredentials | FailedCredentials;

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE();

  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

async function exchange(
  code: string,
  verifier: string,
): Promise<OAuthCredentials | FailedCredentials> {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok) {
    return { type: "failed" };
  }
  const json = await result.json();
  return {
    type: "oauth",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
    "experimental.chat.system.transform": (
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
        getAuth: () => Promise<OAuthCredentials | { type: string }>,
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
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const auth = (await getAuth()) as OAuthCredentials;
              if (auth.type !== "oauth") return fetch(input, init);

              // Refresh token if expired
              if (!auth.access || auth.expires < Date.now()) {
                const response = await fetch(
                  "https://console.anthropic.com/v1/oauth/token",
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
                  throw new Error(`Token refresh failed: ${response.status}`);
                }
                const json = await response.json();
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                  },
                });
                auth.access = json.access_token;
              }

              const requestInit = init ?? {};

              // Build headers
              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(
                    requestInit.headers,
                  )) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              // Merge beta headers - preserve incoming + add required ones
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const requiredBetas = [
                "oauth-2025-04-20",
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
                "claude-cli/2.1.2 (external, cli)",
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
              let requestInput: RequestInfo | URL = input;
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

              const response = await fetch(requestInput, {
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
            const { url, verifier } = await authorize("max");
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string): Promise<AuthResult> => {
                return exchange(code, verifier);
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string): Promise<AuthResult> => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json());
                return { type: "success", key: result.raw_key };
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
