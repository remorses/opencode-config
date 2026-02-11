/**
 * # multicodex plugin
 *
 * This plugin wraps the `openai` provider fetch used by OpenCode and rotates OAuth accounts
 * when a request is rate-limited.
 *
 * ## How it works
 *
 * 1. Send request with current OpenAI OAuth auth.
 * 2. Detect rate-limit style failures (`429`, plus some `403/404` payload markers).
 * 3. Load `multicodex-accounts.json` account pool.
 * 4. Resolve current account index by matching refresh token, accountId, email, then `activeIndex`.
 * 5. Rotate to next account with modulo, refresh token if expired, then persist:
 *    - `multicodex-accounts.json`
 *    - OpenCode auth file (`~/.local/share/opencode/auth.json` or XDG path)
 *    - in-memory auth via `client.auth.set(...)`
 * 6. Retry request until one account succeeds or all accounts are exhausted once.
 *
 * ## Single-account behavior
 *
 * If there are fewer than 2 accounts in `multicodex-accounts.json`, no rotation is attempted.
 * The plugin returns the original response as-is (including rate-limit responses).
 */

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_ISSUER = "https://auth.openai.com";
const MULTICODEX_ACCOUNTS_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../multicodex-accounts.json",
);

type OAuthAuth = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  email?: string;
};

type AccountRecord = {
  email?: string;
  accountId?: string;
  refresh: string;
  access: string;
  expires: number;
  addedAt: number;
  lastUsed: number;
};

type AccountStore = {
  version: number;
  activeIndex: number;
  accounts: AccountRecord[];
};

function authFilePath() {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) return path.join(xdgDataHome, "opencode", "auth.json");
  return path.join(homedir(), ".local", "share", "opencode", "auth.json");
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  await fs.chmod(filePath, 0o600);
}

function normalizeStore(
  input: Partial<AccountStore> | null | undefined,
): AccountStore {
  const accounts = Array.isArray(input?.accounts)
    ? input.accounts.filter(
        (a): a is AccountRecord =>
          !!a &&
          typeof a.refresh === "string" &&
          typeof a.access === "string" &&
          typeof a.expires === "number",
      )
    : [];
  const rawIndex =
    typeof input?.activeIndex === "number" ? Math.floor(input.activeIndex) : 0;
  const activeIndex =
    accounts.length === 0
      ? 0
      : ((rawIndex % accounts.length) + accounts.length) % accounts.length;
  return {
    version: 1,
    activeIndex,
    accounts,
  };
}

async function loadStore() {
  const raw = await readJson<Partial<AccountStore> | null>(
    MULTICODEX_ACCOUNTS_PATH,
    null,
  );
  return normalizeStore(raw);
}

async function saveStore(store: AccountStore) {
  await writeJson(MULTICODEX_ACCOUNTS_PATH, normalizeStore(store));
}

function parseJwtClaims(token: string): Record<string, any> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return undefined;
  }
}

function getEmailFromJwt(token: string) {
  const claims = parseJwtClaims(token);
  return typeof claims?.email === "string" ? claims.email : undefined;
}

function getAccountIdFromJwt(token: string) {
  const claims = parseJwtClaims(token);
  const auth = claims?.["https://api.openai.com/auth"];
  return (
    claims?.chatgpt_account_id ??
    auth?.chatgpt_account_id ??
    claims?.organizations?.[0]?.id ??
    undefined
  );
}

async function refreshAccess(
  refreshToken: string,
): Promise<{ refresh: string; access: string; expires: number } | null> {
  const response = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) return null;
  const data = (await response.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in?: number;
  };

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

function findCurrentIndex(store: AccountStore, auth: OAuthAuth): number {
  if (!store.accounts.length) return 0;

  const byRefresh = store.accounts.findIndex((a) => a.refresh === auth.refresh);
  if (byRefresh >= 0) return byRefresh;

  const byAccountId = auth.accountId
    ? store.accounts.findIndex(
        (a) => a.accountId && a.accountId === auth.accountId,
      )
    : -1;
  if (byAccountId >= 0) return byAccountId;

  const authEmail = getEmailFromJwt(auth.access);
  const byEmail = authEmail
    ? store.accounts.findIndex(
        (a) => a.email && a.email.toLowerCase() === authEmail.toLowerCase(),
      )
    : -1;
  if (byEmail >= 0) return byEmail;

  return store.activeIndex;
}

function isRateLimitedStatus(status: number) {
  return status === 429 || status === 403 || status === 404;
}

async function isRateLimitedResponse(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (!isRateLimitedStatus(response.status)) return false;

  const text = await response
    .clone()
    .text()
    .catch(() => "");
  const haystack = text.toLowerCase();
  return (
    haystack.includes("rate_limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("usage_limit_reached") ||
    haystack.includes("usage_not_included")
  );
}

async function setOpenAIAuth(auth: OAuthAuth, client: any) {
  const authPath = authFilePath();
  const data = await readJson<Record<string, any>>(authPath, {});
  data.openai = auth;
  await writeJson(authPath, data);

  await client.auth.set({
    path: { id: "openai" },
    body: auth,
  });
}

function cloneBodyInit(
  input: string | URL | Request,
  init?: RequestInit,
): RequestInit | undefined {
  if (!init) return init;
  if (init.body == null) return init;
  if (typeof init.body === "string") return init;
  if (input instanceof Request && input.bodyUsed) return init;
  return init;
}

const MultiCodexPlugin: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth) {
        const initial = await getAuth();
        if (initial.type !== "oauth") return {};

        return {
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const baseInit = cloneBodyInit(input, init);
            let response = await fetch(input, baseInit);
            if (!(await isRateLimitedResponse(response))) {
              return response;
            }

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") {
              return response;
            }

            const store = await loadStore();
            if (store.accounts.length < 2) {
              return response;
            }

            const currentIndex = findCurrentIndex(store, currentAuth);

            for (let step = 1; step < store.accounts.length; step++) {
              const nextIndex = (currentIndex + step) % store.accounts.length;
              const next = store.accounts[nextIndex];
              if (!next) continue;

              if (next.expires <= Date.now()) {
                const refreshed = await refreshAccess(next.refresh);
                if (!refreshed) continue;
                next.refresh = refreshed.refresh;
                next.access = refreshed.access;
                next.expires = refreshed.expires;
                next.email = next.email ?? getEmailFromJwt(refreshed.access);
                next.accountId =
                  next.accountId ?? getAccountIdFromJwt(refreshed.access);
              }

              next.lastUsed = Date.now();
              store.activeIndex = nextIndex;

              await saveStore(store);

              await setOpenAIAuth(
                {
                  type: "oauth",
                  refresh: next.refresh,
                  access: next.access,
                  expires: next.expires,
                  accountId: next.accountId,
                  email: next.email,
                },
                client,
              );

              response = await fetch(input, baseInit);
              if (!(await isRateLimitedResponse(response))) {
                return response;
              }
            }

            return response;
          },
        };
      },
    },
  };
};

export { MultiCodexPlugin };
