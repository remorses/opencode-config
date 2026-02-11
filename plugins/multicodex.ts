/**
 * # multicodex plugin
 *
 * This plugin rotates OpenAI Codex OAuth accounts after rate-limit retry events.
 *
 * ## Setup
 *
 * 1. Add this plugin to your OpenCode config (`opencode.json`):
 *    `"plugins": ["file:///absolute/path/to/plugins/multicodex.ts"]`
 * 2. Ensure `multicodex-accounts.json` exists next to this plugin (repo root in this setup).
 * 3. Add at least two OpenAI OAuth accounts with the CLI script:
 *    - `bun scripts/multicodex-cli.ts add`
 *    - `bun scripts/multicodex-cli.ts list`
 *    - `bun scripts/multicodex-cli.ts use <index>`
 *
 * The `add` command uses the same OAuth browser flow as built-in Codex auth, then stores
 * account entries in `multicodex-accounts.json` and syncs the active account to
 * `~/.local/share/opencode/auth.json` (or XDG equivalent).
 *
 * ## Why this shape
 *
 * - No fetch override: avoids conflicts with built-in Codex auth transport.
 * - Triggered by `session.status` retry events.
 * - Prepares the next account for subsequent requests.
 *
 * ## How it works
 *
 * 1. Listen for `session.status` with `status.type === "retry"`.
 * 2. Detect rate-limit retry message (`429`, `rate limit`, usage limit markers).
 * 3. Continue only for models that start with `openai/`.
 * 4. Resolve current account index by matching refresh/accountId/email then `activeIndex`.
 * 5. Switch to next account with modulo and persist:
 *    - `multicodex-accounts.json`
 *    - OpenCode auth file (`~/.local/share/opencode/auth.json` or XDG path)
 *    - in-memory auth via `client.auth.set(...)`
 *
 * ## Single-account behavior
 *
 * If there are fewer than 2 accounts in `multicodex-accounts.json`, no rotation is attempted.
 */

import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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

type AuthFile = Record<string, unknown> & {
  openai?: unknown;
};

type RetryStatusEvent = {
  type: "session.status";
  properties: {
    sessionID: string;
    status: {
      type: "retry";
      message: string;
    };
  };
};

type AuthClient = {
  auth: {
    set: (input: { path: { id: "openai" }; body: OAuthAuth }) => Promise<unknown>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOAuthAuth(value: unknown): OAuthAuth | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "oauth") return undefined;
  if (typeof value.refresh !== "string") return undefined;
  if (typeof value.access !== "string") return undefined;
  if (typeof value.expires !== "number") return undefined;
  return {
    type: "oauth",
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
  };
}

function isRetryStatusEvent(event: unknown): event is RetryStatusEvent {
  if (!isRecord(event) || event.type !== "session.status") return false;
  if (!isRecord(event.properties)) return false;
  const sessionID = event.properties.sessionID;
  const status = event.properties.status;
  if (typeof sessionID !== "string") return false;
  if (!isRecord(status)) return false;
  return status.type === "retry" && typeof status.message === "string";
}

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
  return { version: 1, activeIndex, accounts };
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

  const authEmail = auth.email;
  const byEmail = authEmail
    ? store.accounts.findIndex(
        (a) => a.email && a.email.toLowerCase() === authEmail.toLowerCase(),
      )
    : -1;
  if (byEmail >= 0) return byEmail;

  return store.activeIndex;
}

function isRateLimitText(message: string) {
  const haystack = message.toLowerCase();
  return (
    haystack.includes("429") ||
    haystack.includes("usage limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("rate_limit") ||
    haystack.includes("usage_limit_reached") ||
    haystack.includes("usage_not_included")
  );
}

async function setOpenAIAuth(auth: OAuthAuth, client: AuthClient) {
  const file = authFilePath();
  const data = await readJson<AuthFile>(file, {});
  data.openai = auth;
  await writeJson(file, data);
  await client.auth.set({
    path: { id: "openai" },
    body: auth,
  });
}

function extractSessionModelID(info: unknown): string | undefined {
  if (!isRecord(info)) return undefined;
  if (typeof info.modelID === "string") return info.modelID;
  if (typeof info.modelId === "string") return info.modelId;
  if (typeof info.model === "string") return info.model;
  if (isRecord(info.model) && typeof info.model.id === "string") return info.model.id;
  return undefined;
}

const MultiCodexPlugin: Plugin = async ({ client }) => {
  return {
    async event({ event }) {
      if (!isRetryStatusEvent(event)) return;

      const sessionID = event.properties.sessionID;
      const message = event.properties.status.message;
      if (!message || !isRateLimitText(message)) return;

      const resolvedModelID = await client.session
        .get({ path: { id: sessionID } })
        .then((session) => extractSessionModelID(session.data))
        .catch(() => undefined);
      if (!resolvedModelID || !resolvedModelID.startsWith("openai/")) return;

      const authPath = authFilePath();
      const authData = await readJson<AuthFile>(authPath, {});
      const currentAuth = parseOAuthAuth(authData.openai);
      if (!currentAuth) return;

      const store = await loadStore();
      if (store.accounts.length < 2) return;

      const currentIndex = findCurrentIndex(store, currentAuth);
      const nextIndex = (currentIndex + 1) % store.accounts.length;
      const nextAccount = store.accounts[nextIndex];
      if (!nextAccount) return;

      nextAccount.lastUsed = Date.now();
      store.activeIndex = nextIndex;
      await saveStore(store);

      await setOpenAIAuth(
        {
          type: "oauth",
          refresh: nextAccount.refresh,
          access: nextAccount.access,
          expires: nextAccount.expires,
          accountId: nextAccount.accountId,
          email: nextAccount.email,
        },
        client,
      );
    },
  };
};

export { MultiCodexPlugin };
