// CLI for multicodex account management using the same OAuth browser flow as OpenCode Codex plugin.

import fs from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const OAUTH_PORT = 1455;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;
const STORE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../multicodex-accounts.json",
);

type Tokens = {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

type Account = {
  email?: string;
  accountId?: string;
  refresh: string;
  access: string;
  expires: number;
  addedAt: number;
  type: "oauth";
  lastUsed: number;
};

type Store = {
  version: number;
  activeIndex: number;
  accounts: Account[];
};

type PendingOAuth = {
  verifier: string;
  state: string;
  resolve: (tokens: Tokens) => void;
  reject: (error: Error) => void;
};

const HTML_SUCCESS = `<!doctype html>
<html><body><h1>Authorization Successful</h1><p>You can close this window.</p></body></html>`;
const htmlError = (error: string) =>
  `<!doctype html><html><body><h1>Authorization Failed</h1><pre>${error}</pre></body></html>`;

let oauthServer: ReturnType<typeof createServer> | undefined;
let pendingOAuth: PendingOAuth | undefined;

function authFilePath() {
  if (process.env.XDG_DATA_HOME)
    return path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json");
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

function normalizeStore(input: Partial<Store> | null | undefined): Store {
  const accounts = Array.isArray(input?.accounts)
    ? input.accounts.filter(
        (x): x is Account =>
          !!x &&
          typeof x.refresh === "string" &&
          typeof x.access === "string" &&
          typeof x.expires === "number",
      )
    : [];
  const raw =
    typeof input?.activeIndex === "number" ? Math.floor(input.activeIndex) : 0;
  const activeIndex =
    accounts.length === 0
      ? 0
      : ((raw % accounts.length) + accounts.length) % accounts.length;
  return { version: 1, activeIndex, accounts };
}

async function loadStore() {
  const raw = await readJson<Partial<Store> | null>(STORE_PATH, null);
  return normalizeStore(raw);
}

async function saveStore(store: Store) {
  await writeJson(STORE_PATH, normalizeStore(store));
}

function randomString(length: number) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE() {
  const verifier = randomString(43);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(hash) };
}

function generateState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function extractAccountId(tokens: Tokens) {
  const idClaims = tokens.id_token
    ? parseJwtClaims(tokens.id_token)
    : undefined;
  const accessClaims = parseJwtClaims(tokens.access_token);
  const idAuth =
    (idClaims?.["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined) ?? undefined;
  const accessAuth =
    (accessClaims?.["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined) ?? undefined;

  return (
    (typeof idClaims?.chatgpt_account_id === "string"
      ? idClaims.chatgpt_account_id
      : undefined) ??
    (typeof idAuth?.chatgpt_account_id === "string"
      ? idAuth.chatgpt_account_id
      : undefined) ??
    (Array.isArray(idClaims?.organizations) &&
    typeof (idClaims.organizations[0] as Record<string, unknown> | undefined)
      ?.id === "string"
      ? ((idClaims.organizations[0] as Record<string, unknown>).id as string)
      : undefined) ??
    (typeof accessClaims?.chatgpt_account_id === "string"
      ? accessClaims.chatgpt_account_id
      : undefined) ??
    (typeof accessAuth?.chatgpt_account_id === "string"
      ? accessAuth.chatgpt_account_id
      : undefined)
  );
}

function extractEmail(tokens: Tokens) {
  const idClaims = tokens.id_token
    ? parseJwtClaims(tokens.id_token)
    : undefined;
  const accessClaims = parseJwtClaims(tokens.access_token);
  return (
    (typeof idClaims?.email === "string" ? idClaims.email : undefined) ??
    (typeof accessClaims?.email === "string" ? accessClaims.email : undefined)
  );
}

function buildAuthorizeUrl(pkce: { challenge: string }, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, verifier: string) {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  if (!response.ok)
    throw new Error(`Token exchange failed: ${response.status}`);
  return (await response.json()) as Tokens;
}

function handleOAuthRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_PORT}`);
  if (url.pathname !== "/auth/callback") {
    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"));
      pendingOAuth = undefined;
      res.statusCode = 200;
      res.end("Login cancelled");
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    const message = errorDescription || error;
    pendingOAuth?.reject(new Error(message));
    pendingOAuth = undefined;
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html");
    res.end(htmlError(message));
    return;
  }

  if (!code) {
    const message = "Missing authorization code";
    pendingOAuth?.reject(new Error(message));
    pendingOAuth = undefined;
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html");
    res.end(htmlError(message));
    return;
  }

  if (!pendingOAuth || state !== pendingOAuth.state) {
    const message = "Invalid state - potential CSRF attack";
    pendingOAuth?.reject(new Error(message));
    pendingOAuth = undefined;
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html");
    res.end(htmlError(message));
    return;
  }

  const current = pendingOAuth;
  pendingOAuth = undefined;
  exchangeCodeForTokens(code, current.verifier)
    .then((tokens) => current.resolve(tokens))
    .catch((err) =>
      current.reject(err instanceof Error ? err : new Error(String(err))),
    );

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
  res.end(HTML_SUCCESS);
}

async function startOAuthServer() {
  if (oauthServer) return;
  oauthServer = createServer(handleOAuthRequest);
  await new Promise<void>((resolve, reject) => {
    oauthServer?.once("error", reject);
    oauthServer?.listen(OAUTH_PORT, "127.0.0.1", () => resolve());
  });
}

async function stopOAuthServer() {
  if (!oauthServer) return;
  await new Promise<void>((resolve) => oauthServer?.close(() => resolve()));
  oauthServer = undefined;
}

function waitForOAuthCallback(
  verifier: string,
  state: string,
): Promise<Tokens> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined;
          reject(
            new Error("OAuth callback timeout - authorization took too long"),
          );
        }
      },
      5 * 60 * 1000,
    );

    pendingOAuth = {
      verifier,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout);
        resolve(tokens);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
}

function openBrowser(url: string) {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function upsert(store: Store, account: Account) {
  const idx = store.accounts.findIndex(
    (x) =>
      (account.accountId && x.accountId && account.accountId === x.accountId) ||
      (account.email &&
        x.email &&
        account.email.toLowerCase() === x.email.toLowerCase()) ||
      account.refresh === x.refresh,
  );
  if (idx < 0) {
    store.accounts.push(account);
    store.activeIndex = store.accounts.length - 1;
    return store.activeIndex;
  }
  const existing = store.accounts[idx];
  if (!existing) return idx;
  store.accounts[idx] = {
    ...existing,
    ...account,
    addedAt: existing.addedAt ?? account.addedAt,
  };
  store.activeIndex = idx;
  return idx;
}

async function syncAuthFile(account: Account) {
  const p = authFilePath();
  const data = await readJson<Record<string, unknown>>(p, {});
  data.openai = {
    type: "oauth",
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    accountId: account.accountId,
    email: account.email,
  };
  await writeJson(p, data);
}

async function cmdAdd() {
  await startOAuthServer();
  const pkce = await generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(pkce, state);
  const callbackPromise = waitForOAuthCallback(pkce.verifier, state);

  console.log("Starting OAuth login...");
  console.log(`Callback: ${REDIRECT_URI}`);
  console.log(`OAuth URL: ${authUrl}`);
  openBrowser(authUrl);

  const tokens = await callbackPromise;
  await stopOAuthServer();

  const now = Date.now();
  const account: Account = {
    email: extractEmail(tokens),
    accountId: extractAccountId(tokens),
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    addedAt: now,
    type: "oauth",
    lastUsed: now,
  };

  const store = await loadStore();
  const idx = upsert(store, account);
  await saveStore(store);
  await syncAuthFile(account);
  console.log(
    `Added account #${idx + 1}${account.email ? ` (${account.email})` : ""}`,
  );
  console.log(`Store: ${STORE_PATH}`);
}

async function cmdList() {
  const store = await loadStore();
  console.log(`Store: ${STORE_PATH}`);
  if (!store.accounts.length) {
    console.log("No accounts configured.");
    return;
  }
  store.accounts.forEach((x, i) => {
    const active = i === store.activeIndex ? "*" : " ";
    const label = x.email ?? x.accountId ?? "unknown";
    console.log(`${active} ${i + 1}. ${label}`);
  });
}

async function cmdUse(arg?: string) {
  const n = Number(arg);
  if (!Number.isFinite(n) || n < 1)
    throw new Error("Usage: bun scripts/multicodex-cli.ts use <index>");
  const store = await loadStore();
  const idx = Math.floor(n - 1);
  const account = store.accounts[idx];
  if (!account) throw new Error(`Account ${n} does not exist`);
  account.lastUsed = Date.now();
  store.activeIndex = idx;
  await saveStore(store);
  await syncAuthFile(account);
  console.log(
    `Switched to account ${n}${account.email ? ` (${account.email})` : ""}`,
  );
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("multicodex CLI");
    console.log("Commands:");
    console.log("  add           OAuth login and add or update account");
    console.log("  list          List configured accounts");
    console.log("  use <index>   Activate account by 1-based index");
    return;
  }
  if (command === "add") return cmdAdd();
  if (command === "list") return cmdList();
  if (command === "use") return cmdUse(arg);
  throw new Error(`Unknown command: ${command}`);
}

main().catch(async (error) => {
  await stopOAuthServer().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
