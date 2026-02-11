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
 * 1. Listen for `session.status` retry events.
 * 2. Detect rate-limit style retry messages (`429`, `rate limit`, usage limit markers).
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
import { MulticodexLogger } from "./utils/multicodex-logger";

const MULTICODEX_ACCOUNTS_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../multicodex-accounts.json",
);
const logger = new MulticodexLogger();

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

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function emailFromAccessToken(access: string): string | undefined {
  const claims = parseJwtClaims(access);
  const profile =
    claims && typeof claims["https://api.openai.com/profile"] === "object"
      ? (claims["https://api.openai.com/profile"] as Record<string, unknown>)
      : undefined;
  const direct = typeof claims?.email === "string" ? claims.email : undefined;
  const nested = typeof profile?.email === "string" ? profile.email : undefined;
  return direct ?? nested;
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

async function setOpenAIAuth(auth: OAuthAuth, client: any) {
  const file = authFilePath();
  const data = await readJson<Record<string, unknown>>(file, {});
  data.openai = {
    ...auth,
    email: auth.email ?? emailFromAccessToken(auth.access),
  };
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

function extractModelFromMessageInfo(info: any): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  if (typeof info.providerID === "string" && typeof info.modelID === "string") {
    return `${info.providerID}/${info.modelID}`;
  }
  if (info.model && typeof info.model.providerID === "string" && typeof info.model.modelID === "string") {
    return `${info.model.providerID}/${info.model.modelID}`;
  }
  return undefined;
}

async function resolveModelID(sessionID: string, client: any) {
  const fromSession = await client.session
    .get({ path: { id: sessionID } })
    .then((session: any) => extractSessionModelID(session?.data))
    .catch(() => undefined);
  if (fromSession) return fromSession;

  const fromMessages = await client.session
    .messages({ path: { id: sessionID } })
    .then((result: any) => {
      const messages = Array.isArray(result?.data) ? result.data : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        const model = extractModelFromMessageInfo(info);
        if (model) return model;
      }
      return undefined;
    })
    .catch(() => undefined);

  return fromMessages;
}

const MultiCodexPlugin: Plugin = async ({ client }) => {
  await logger.info("multicodex plugin initialized", {
    accountsPath: MULTICODEX_ACCOUNTS_PATH,
    authPath: authFilePath(),
    logPath: logger.logPath,
  });

  return {
    async event({ event }) {
      const evt: any = event;
      await logger.debug("plugin event received", {
        type: evt.type,
      });

      try {
        if (evt.type === "session.status") {
          await logger.info("session.status received", {
            sessionID: evt.properties?.sessionID,
            status: evt.properties?.status,
          });
        }

        const isRetryStatus =
          evt.type === "session.status" &&
          evt.properties?.status?.type === "retry" &&
          typeof evt.properties?.status?.message === "string";
        if (!isRetryStatus) return;

        const sessionID = evt.properties?.sessionID;
        if (!sessionID) {
          await logger.warn("retry status without sessionID", {
            eventType: evt.type,
          });
          return;
        }

        const message = evt.properties.status.message as string;
        const attempt = Number(evt.properties.status.attempt ?? 0);
        const nextRetryAt = Number(evt.properties.status.next ?? 0);

        await logger.info("retry status captured", {
          sessionID,
          attempt,
          nextRetryAt,
          message,
          isRateLimit: isRateLimitText(message),
        });

        if (!message || !isRateLimitText(message)) {
          await logger.debug("skipping retry status without rate-limit markers", {
            sessionID,
            message,
          });
          return;
        }

        const resolvedModelID = await resolveModelID(sessionID, client);

        await logger.info("session model resolved", {
          sessionID,
          modelID: resolvedModelID,
        });

        if (!resolvedModelID || !resolvedModelID.startsWith("openai/")) {
          await logger.debug("skipping non-openai model", {
            sessionID,
            modelID: resolvedModelID,
          });
          return;
        }

        const authPath = authFilePath();
        const authData = await readJson<Record<string, unknown>>(authPath, {});
        const current = authData.openai;
        if (!current || typeof current !== "object") {
          await logger.warn("openai auth missing in auth.json", {
            sessionID,
            authPath,
          });
          return;
        }
        if ((current as any).type !== "oauth") {
          await logger.warn("openai auth is not oauth", {
            sessionID,
            authType: (current as any).type,
          });
          return;
        }

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
        await logger.info("account store loaded", {
          sessionID,
          accountCount: store.accounts.length,
          activeIndex: store.activeIndex,
        });

        if (store.accounts.length < 2) {
          await logger.debug("rotation skipped: insufficient accounts", {
            sessionID,
            accountCount: store.accounts.length,
          });
          return;
        }

        const currentIndex = findCurrentIndex(store, currentAuth);
        const nextIndex = (currentIndex + 1) % store.accounts.length;
        const nextAccount = store.accounts[nextIndex];
        if (!nextAccount) {
          await logger.warn("rotation skipped: next account missing", {
            sessionID,
            currentIndex,
            nextIndex,
            accountCount: store.accounts.length,
          });
          return;
        }

        await logger.info("rotating account", {
          sessionID,
          currentIndex,
          nextIndex,
          currentEmail: currentAuth.email,
          nextEmail: nextAccount.email,
          currentAccountId: currentAuth.accountId,
          nextAccountId: nextAccount.accountId,
        });

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

        await logger.info("rotation complete", {
          sessionID,
          newActiveIndex: nextIndex,
          newEmail: nextAccount.email,
          newAccountId: nextAccount.accountId,
        });
      } catch (error) {
        await logger.error("rotation failed", error, {
          eventType: evt.type,
        });
      }
    },
  };
};

export { MultiCodexPlugin };
