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

async function setOpenAIAuth(auth: OAuthAuth, client: any) {
  const file = authFilePath();
  const data = await readJson<Record<string, unknown>>(file, {});
  data.openai = auth;
  await writeJson(file, data);
  await client.auth.set({
    path: { id: "openai" },
    body: data.openai,
  });
}

function extractSessionModelID(info: any): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  if (typeof info.modelID === "string") return info.modelID;
  if (typeof info.modelId === "string") return info.modelId;
  if (typeof info.model === "string") return info.model;
  if (info.model && typeof info.model.id === "string") return info.model.id;
  return undefined;
}

const MultiCodexPlugin: Plugin = async ({ client }) => {
  return {
    async event({ event }) {
      const evt: any = event;

      const isRetryStatus =
        evt.type === "session.status" &&
        evt.properties?.status?.type === "retry" &&
        typeof evt.properties?.status?.message === "string";
      if (!isRetryStatus) return;

      const sessionID = evt.properties?.sessionID;
      if (!sessionID) return;

      const message = evt.properties.status.message as string;
      if (!message || !isRateLimitText(message)) return;

      const resolvedModelID = await client.session
        .get({ path: { id: sessionID } })
        .then((session: any) => extractSessionModelID(session?.data))
        .catch(() => undefined);
      if (!resolvedModelID || !resolvedModelID.startsWith("openai/")) return;

      const authPath = authFilePath();
      const authData = await readJson<Record<string, unknown>>(authPath, {});
      const current = authData.openai;
      if (!current || typeof current !== "object") return;
      if ((current as any).type !== "oauth") return;

      const currentAuth: OAuthAuth = {
        type: "oauth",
        refresh: String((current as any).refresh ?? ""),
        access: String((current as any).access ?? ""),
        expires: Number((current as any).expires ?? 0),
        accountId:
          typeof (current as any).accountId === "string"
            ? (current as any).accountId
            : undefined,
        email:
          typeof (current as any).email === "string"
            ? (current as any).email
            : undefined,
      };

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
