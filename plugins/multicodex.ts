/**
 * # multicodex plugin
 *
 * This plugin rotates OpenAI Codex OAuth accounts after rate-limit session errors.
 *
 * ## Why this shape
 *
 * - It does not override provider fetch.
 * - It avoids interfering with OpenCode's built-in Codex auth transport.
 * - It only prepares the next account for subsequent requests.
 *
 * ## How it works
 *
 * 1. Listen for `session.error` events.
 * 2. Detect rate-limit style errors from message text (`429`, `rate limit`, usage limit markers).
 * 3. Resolve current session model and continue only when it starts with `openai/`.
 * 4. Load `multicodex-accounts.json` account pool and current OpenAI auth.
 * 5. Resolve current account index by matching refresh token, accountId, email, then `activeIndex`.
 * 6. Switch to next account with modulo, then persist:
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
    body: auth,
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
      if (event.type !== "session.error") return;
      const sessionID = event.properties.sessionID;
      if (!sessionID) return;

      const err = event.properties.error as any;
      const message =
        (typeof err?.message === "string" ? err.message : "") ||
        (typeof err?.data?.message === "string" ? err.data.message : "");
      if (!message || !isRateLimitText(message)) return;

      const session = await client.session
        .get({ path: { id: sessionID } })
        .catch(() => ({ data: null }));
      const modelID = extractSessionModelID((session as any)?.data);
      if (!modelID || !modelID.startsWith("openai/")) return;

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
      const next = store.accounts[nextIndex];
      if (!next) return;

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
    },
  };
};

export { MultiCodexPlugin };
