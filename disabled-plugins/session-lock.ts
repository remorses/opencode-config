/**
 * # Session Lock Plugin
 *
 * This plugin makes it practical to run many agent sessions in the same
 * codebase without stepping on each other.
 *
 * ## Why this exists
 *
 * Worktrees are powerful, but for high-parallel agent workflows they can add
 * accidental complexity (extra branches, sync overhead, cleanup, and context
 * drift). This plugin takes a simpler approach for a shared checkout:
 *
 * - Let all sessions explore and plan freely in the same tree.
 * - Serialize only the small mutation window (writes and mutating git).
 * - Keep users informed while sessions wait.
 *
 * In practice, most agent time is spent reading, searching, planning, and
 * reasoning. Actual write time is usually short. Because of that, queueing the
 * write phase gives high throughput with much lower operational complexity.
 *
 * ## Lock semantics
 *
 * Locks are session-scoped and long-lived: once acquired, they are held until
 * the session goes idle or is deleted.
 *
 * - File locks: for `write`, `edit`, `multiedit`, and files touched by
 *   `apply_patch`.
 * - Repo locks: for side-effecting `git` commands executed via `bash`.
 *
 * Queueing is fair per lock key. A session joins a FIFO queue and waits with
 * sleep-based polling until it reaches the head and the lock is available.
 *
 * ## Lock keys
 *
 * - File key format: `file:<absolute-path>`
 * - Repo key format: `repo:<resolved-working-directory>`
 *
 * For git commands, the lock key is derived from the resolved command cwd
 * (`bash.workdir` when present, otherwise project directory).
 *
 * ## Release semantics
 *
 * Locks are released when:
 *
 * - The owning session emits `session.status` with `idle`
 * - The owning session is deleted (`session.deleted`)
 *
 * Queue entries are always cleaned up after acquire attempts, and stale lock
 * owners can be reaped so the system keeps moving after crashes.
 *
 * ## Status visibility
 *
 * The plugin emits lock lifecycle updates (`queued`, `waiting`, `acquired`,
 * `released`, `timeout`, `stale_reaped`) to both app logs and TUI toasts, so
 * contention is visible instead of silent.
 */

import type { Hooks, PluginInput, Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import * as fs from "fs/promises"
import * as nodefs from "fs"
import * as path from "path"
import crypto from "crypto"
import { Language } from "web-tree-sitter"
import { fileURLToPath } from "url"
import lockfile from "proper-lockfile"

// -----------------------------------------------------------------------------
// SessionLock class (SQLite + proper-lockfile coordination)
// -----------------------------------------------------------------------------

type Release = () => Promise<void>

type LockPhase = "queued" | "waiting" | "acquired" | "released" | "stale_reaped" | "timeout"

type LockStatus = {
  phase: LockPhase
  sessionID: string
  kind: "file" | "repo"
  key: string
  target: string
  queuePosition?: number
  queueLength?: number
  ownerSession?: string
  waitMs?: number
  releasedCount?: number
}

type Row = {
  key: string
  session: string
  kind: "file" | "repo"
  target: string
  lockfile: string
  created: number
}

type QueueRow = {
  ticket: number
  key: string
  session: string
  kind: "file" | "repo"
  target: string
  created: number
}

type Held = {
  sessionID: string
  release: Release
}

type Lockfile = {
  lock(
    file: string,
    options: {
      realpath: boolean
      stale: number
      update: number
      lockfilePath: string
      onCompromised: (err: Error) => void
    },
  ): Promise<Release>
  unlock(file: string, options: { realpath: boolean; lockfilePath: string }): Promise<void>
}

type SessionLockOptions = {
  directory: string
  staleMs?: number
  pollMs?: number
  maxWaitMs?: number
  notify?: (status: LockStatus) => Promise<void> | void
}

class SessionLock {
  readonly directory: string
  readonly staleMs: number
  readonly pollMs: number
  readonly maxWaitMs: number

  #db: Database
  #held = new Map<string, Held>()
  #lockfile: Lockfile
  #notify?: (status: LockStatus) => Promise<void> | void

  constructor(options: SessionLockOptions & { lockfile: Lockfile }) {
    this.directory = options.directory
    this.staleMs = options.staleMs ?? 2 * 60_000
    this.pollMs = Math.max(100, options.pollMs ?? 250)
    this.maxWaitMs = Math.max(this.staleMs * 2, options.maxWaitMs ?? 10 * 60_000)
    this.#db = openDb(options.directory)
    this.#lockfile = options.lockfile
    this.#notify = options.notify
  }

  async file(sessionID: string, filepath: string) {
    const file = path.isAbsolute(filepath) ? filepath : path.join(this.directory, filepath)
    const key = `file:${path.resolve(file)}`
    await this.#acquire({ key, sessionID, kind: "file", target: file })
  }

  async repo(sessionID: string, cwd: string) {
    const dir = path.resolve(path.isAbsolute(cwd) ? cwd : path.join(this.directory, cwd))
    const key = `repo:${dir}`
    await this.#acquire({ key, sessionID, kind: "repo", target: dir })
  }

  async releaseSession(sessionID: string) {
    const rows = this.#db
      .query<Row, [string]>("select key, session, kind, target, lockfile, created from lock where session = ?")
      .all(sessionID)

    await this.#write(() => {
      this.#db.query("delete from lock where session = ?").run(sessionID)
      this.#db.query("delete from wait_queue where session = ?").run(sessionID)
    })

    await Promise.all(
      rows.map(async (row) => {
        const held = this.#held.get(row.key)
        if (held && held.sessionID === sessionID) {
          this.#held.delete(row.key)
          await held.release().catch(() => {})
          return
        }
        await this.#lockfile.unlock(row.target, { realpath: false, lockfilePath: row.lockfile }).catch(() => {})
      }),
    )

    if (rows.length > 0) {
      const first = rows[0]
      if (first) {
        await this.#emit({
          phase: "released",
          sessionID,
          key: first.key,
          kind: first.kind,
          target: first.target,
          releasedCount: rows.length,
        })
      }
    }
  }

  async #acquire(input: { key: string; sessionID: string; kind: Row["kind"]; target: string }) {
    await ensureDir(path.join(this.directory, ".opencode", "locks"))
    const lockfilePath = path.join(this.directory, ".opencode", "locks", hash(input.key) + ".lock")
    const held = this.#held.get(input.key)
    if (held?.sessionID === input.sessionID) return

    const started = Date.now()
    const ticket = await this.#enqueue(input)
    await this.#emit({
      phase: "queued",
      sessionID: input.sessionID,
      key: input.key,
      kind: input.kind,
      target: input.target,
      queuePosition: 1,
      queueLength: 1,
      waitMs: 0,
    })

    let lastWaitUpdate = 0
    let lastRowOwner = ""

    try {
      while (true) {
        const now = Date.now()
        const waitMs = now - started
        if (waitMs > this.maxWaitMs) {
          await this.#emit({
            phase: "timeout",
            sessionID: input.sessionID,
            key: input.key,
            kind: input.kind,
            target: input.target,
            waitMs,
          })
          throw new Error(
            `${input.kind} lock timed out after ${Math.ceil(waitMs / 1000)}s (${input.target})`,
          )
        }

        const queue = this.#queueState(input.key, ticket)
        if (queue.position > 1) {
          if (now - lastWaitUpdate >= 1500) {
            await this.#emit({
              phase: "waiting",
              sessionID: input.sessionID,
              key: input.key,
              kind: input.kind,
              target: input.target,
              queuePosition: queue.position,
              queueLength: queue.length,
              ownerSession: queue.headSession,
              waitMs,
            })
            lastWaitUpdate = now
          }
          await Bun.sleep(this.pollMs)
          continue
        }

        const row = this.#db
          .query<Row, [string]>("select key, session, kind, target, lockfile, created from lock where key = ?")
          .get(input.key)

        if (row?.session === input.sessionID) {
          if (!this.#held.has(input.key)) {
            const release = await this.#lockfile.lock(input.target, this.#options(lockfilePath))
            this.#held.set(input.key, { sessionID: input.sessionID, release })
          }
          await this.#emit({
            phase: "acquired",
            sessionID: input.sessionID,
            key: input.key,
            kind: input.kind,
            target: input.target,
            queuePosition: queue.position,
            queueLength: queue.length,
            waitMs,
          })
          return
        }

        if (row) {
          const stale = await isStale(row.lockfile, this.staleMs)
          if (stale) {
            await this.#write(() => this.#db.query("delete from lock where key = ?").run(input.key))
            await this.#lockfile
              .unlock(row.target, { realpath: false, lockfilePath: row.lockfile })
              .catch(() => {})
            await this.#emit({
              phase: "stale_reaped",
              sessionID: input.sessionID,
              key: input.key,
              kind: input.kind,
              target: input.target,
              ownerSession: row.session,
              waitMs,
            })
            continue
          }

          if (now - lastWaitUpdate >= 1500 || lastRowOwner !== row.session) {
            await this.#emit({
              phase: "waiting",
              sessionID: input.sessionID,
              key: input.key,
              kind: input.kind,
              target: input.target,
              queuePosition: queue.position,
              queueLength: queue.length,
              ownerSession: row.session,
              waitMs,
            })
            lastWaitUpdate = now
            lastRowOwner = row.session
          }
          await Bun.sleep(this.pollMs)
          continue
        }

        let release: Release | undefined
        try {
          release = await this.#lockfile.lock(input.target, this.#options(lockfilePath))
        } catch {
          if (now - lastWaitUpdate >= 1500) {
            await this.#emit({
              phase: "waiting",
              sessionID: input.sessionID,
              key: input.key,
              kind: input.kind,
              target: input.target,
              queuePosition: queue.position,
              queueLength: queue.length,
              waitMs,
            })
            lastWaitUpdate = now
          }
          await Bun.sleep(this.pollMs)
          continue
        }

        try {
          await this.#write(() =>
            this.#db
              .query("insert into lock (key, session, kind, target, lockfile, created) values (?, ?, ?, ?, ?, ?)")
              .run(input.key, input.sessionID, input.kind, input.target, lockfilePath, now),
          )
        } catch (e) {
          await release().catch(() => {})
          const msg = e instanceof Error ? e.message : String(e)
          if (/SQLITE_(BUSY|LOCKED|CONSTRAINT)/i.test(msg) || /database is locked/i.test(msg)) {
            await Bun.sleep(this.pollMs)
            continue
          }
          throw e
        }

        this.#held.set(input.key, { sessionID: input.sessionID, release })
        await this.#emit({
          phase: "acquired",
          sessionID: input.sessionID,
          key: input.key,
          kind: input.kind,
          target: input.target,
          queuePosition: queue.position,
          queueLength: queue.length,
          waitMs,
        })
        return
      }
    } finally {
      await this.#dequeue(ticket)
    }
  }

  async #enqueue(input: { key: string; sessionID: string; kind: Row["kind"]; target: string }) {
    const now = Date.now()
    const result = await this.#write(() =>
      this.#db
        .query("insert into wait_queue (key, session, kind, target, created) values (?, ?, ?, ?, ?)")
        .run(input.key, input.sessionID, input.kind, input.target, now),
    )
    const raw = (result as { lastInsertRowid?: number | bigint }).lastInsertRowid
    if (typeof raw === "bigint") return Number(raw)
    if (typeof raw === "number") return raw

    const fallback = this.#db
      .query<{ ticket: number }, []>("select ifnull(max(ticket), 0) as ticket from wait_queue")
      .get()
    return fallback?.ticket ?? 0
  }

  async #dequeue(ticket: number) {
    await this.#write(() => this.#db.query("delete from wait_queue where ticket = ?").run(ticket))
  }

  #queueState(key: string, ticket: number) {
    const head = this.#db
      .query<{ ticket: number; session: string }, [string]>(
        "select ticket, session from wait_queue where key = ? order by ticket asc limit 1",
      )
      .get(key)

    const position =
      this.#db
        .query<{ position: number }, [string, number]>(
          "select count(*) as position from wait_queue where key = ? and ticket <= ?",
        )
        .get(key, ticket)?.position ?? 1

    const length =
      this.#db
        .query<{ length: number }, [string]>("select count(*) as length from wait_queue where key = ?")
        .get(key)?.length ?? 1

    return {
      position,
      length,
      headSession: head?.session,
    }
  }

  async #emit(status: LockStatus) {
    if (!this.#notify) return
    await this.#notify(status)
  }

  async #write<T>(fn: () => T) {
    for (let i = 0; i < 8; i++) {
      try {
        return fn()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!/SQLITE_(BUSY|LOCKED)/.test(msg) && !/database is locked/i.test(msg)) {
          throw e
        }
        await Bun.sleep(25 * Math.pow(2, i))
      }
    }
    return fn()
  }

  #options(lockfilePath: string) {
    return {
      realpath: false,
      stale: this.staleMs,
      update: Math.max(1000, Math.floor(this.staleMs / 2)),
      lockfilePath,
      onCompromised: () => {},
    }
  }
}

function openDb(dir: string) {
  const file = path.join(dir, ".opencode", "locks.sqlite")
  nodefs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.exec("pragma journal_mode = WAL")
  db.exec("pragma synchronous = NORMAL")
  db.exec("pragma busy_timeout = 5000")
  db.exec(
    "create table if not exists lock (key text primary key, session text not null, kind text not null, target text not null, lockfile text not null, created integer not null)",
  )
  const cols = db
    .query<{ name: string }, []>("pragma table_info(lock)")
    .all()
    .map((c) => c.name)
  if (!cols.includes("target")) {
    db.exec("alter table lock add column target text")
    db.exec(
      "update lock set target = case when key like 'file:%' then substr(key, 6) when key like 'repo:%' then substr(key, 6) else key end where target is null",
    )
  }
  db.exec("create index if not exists lock_session on lock(session)")
  db.exec(
    "create table if not exists wait_queue (ticket integer primary key autoincrement, key text not null, session text not null, kind text not null, target text not null, created integer not null)",
  )
  db.exec("create index if not exists wait_queue_key_ticket on wait_queue(key, ticket)")
  db.exec("create index if not exists wait_queue_session on wait_queue(session)")
  return db
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

function hash(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex")
}

async function isStale(lockfilePath: string, staleMs: number) {
  const stats = await fs.stat(lockfilePath).catch(() => undefined)
  if (!stats) return true
  return Date.now() - stats.mtime.getTime() > staleMs
}

// -----------------------------------------------------------------------------
// Patch parser (minimal, just extracts file paths)
// -----------------------------------------------------------------------------

type Hunk =
  | { type: "add"; path: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string }

function parsePatch(patchText: string): { hunks: Hunk[] } {
  const lines = patchText.trim().split("\n")
  const hunks: Hunk[] = []

  const beginMarker = "*** Begin Patch"
  const endMarker = "*** End Patch"
  const beginIdx = lines.findIndex((line) => line.trim() === beginMarker)
  const endIdx = lines.findIndex((line) => line.trim() === endMarker)

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    return { hunks }
  }

  for (let i = beginIdx + 1; i < endIdx; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.startsWith("*** Add File:")) {
      const filePath = line.split(":", 2)[1]?.trim()
      if (filePath) hunks.push({ type: "add", path: filePath })
    } else if (line.startsWith("*** Delete File:")) {
      const filePath = line.split(":", 2)[1]?.trim()
      if (filePath) hunks.push({ type: "delete", path: filePath })
    } else if (line.startsWith("*** Update File:")) {
      const filePath = line.split(":", 2)[1]?.trim()
      let movePath: string | undefined
      const nextLine = lines[i + 1]
      if (i + 1 < endIdx && nextLine?.startsWith("*** Move to:")) {
        movePath = nextLine.split(":", 2)[1]?.trim()
      }
      if (filePath) hunks.push({ type: "update", path: filePath, move_path: movePath })
    }
  }

  return { hunks }
}

function filesFromPatch(dir: string, patchText: string) {
  const hunks = parsePatch(patchText).hunks
  const files = new Set<string>()
  for (const hunk of hunks) {
    const filePath = path.resolve(dir, hunk.path)
    files.add(filePath)
    if (hunk.type === "update" && hunk.move_path) {
      files.add(path.resolve(dir, hunk.move_path))
    }
  }
  return Array.from(files)
}

// -----------------------------------------------------------------------------
// Tree-sitter bash parser for git side-effect detection
// -----------------------------------------------------------------------------

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

import type { Parser as TreeSitterParser } from "web-tree-sitter"
let parserPromise: Promise<TreeSitterParser> | undefined

function getParser() {
  if (!parserPromise) {
    parserPromise = (async () => {
      const { Parser } = await import("web-tree-sitter")
      const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
        // @ts-ignore
        with: { type: "wasm" },
      })
      const treePath = resolveWasm(treeWasm)
      await Parser.init({
        locateFile() {
          return treePath
        },
      })
      const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
        // @ts-ignore
        with: { type: "wasm" },
      })
      const bashPath = resolveWasm(bashWasm)
      const bashLanguage = await Language.load(bashPath)
      const p = new Parser()
      p.setLanguage(bashLanguage)
      return p
    })()
  }
  return parserPromise
}

const readOnlyGit = new Set([
  "help",
  "version",
  "status",
  "diff",
  "show",
  "log",
  "reflog",
  "rev-parse",
  "cat-file",
  "ls-files",
  "ls-tree",
  "grep",
  "blame",
  "describe",
])

function isGitSideEffect(argv: string[]) {
  const args = argv.slice()
  if (args[0] === "sudo") args.shift()
  if (args[0] !== "git") return false

  let i = 1
  while (i < args.length) {
    const a = args[i]
    if (!a) break

    if (a === "-c" || a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i += 2
      continue
    }
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=") || a.startsWith("--namespace=")) {
      i += 1
      continue
    }
    if (a === "--no-pager" || a === "-p" || a === "--paginate") {
      i += 1
      continue
    }
    if (a.startsWith("-")) {
      i += 1
      continue
    }
    break
  }

  const sub = args[i]
  if (!sub) return false
  if (readOnlyGit.has(sub)) return false
  return true
}

async function gitSideEffects(cmd: string) {
  const parser = await getParser()
  const tree = parser.parse(cmd)
  if (!tree) return false

  for (const node of tree.rootNode.descendantsOfType("command")) {
    if (!node) continue

    const argv: string[] = []
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (
        child.type !== "command_name" &&
        child.type !== "word" &&
        child.type !== "string" &&
        child.type !== "raw_string" &&
        child.type !== "concatenation"
      ) {
        continue
      }
      argv.push(child.text)
    }
    if (isGitSideEffect(argv)) return true
  }
  return false
}

function fallbackGitSideEffects(cmd: string) {
  return /(^|[;&|]\s*)git(\s|$)/.test(cmd)
}

// -----------------------------------------------------------------------------
// Plugin
// -----------------------------------------------------------------------------

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

const SessionLockPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const waitToastDebounce = new Map<string, number>()

  function shortTarget(target: string) {
    const rel = path.relative(input.directory, target)
    if (!rel || rel === ".") return target
    if (rel.startsWith("..")) return target
    return rel
  }

  function statusMessage(status: LockStatus) {
    const label = shortTarget(status.target)
    const wait = status.waitMs ? ` (${Math.max(1, Math.ceil(status.waitMs / 1000))}s)` : ""
    const queue =
      typeof status.queuePosition === "number" && typeof status.queueLength === "number"
        ? ` [${status.queuePosition}/${status.queueLength}]`
        : ""

    if (status.phase === "queued") return `Queued ${status.kind} lock for ${label}${queue}`
    if (status.phase === "waiting") {
      const owner = status.ownerSession ? ` owner=${status.ownerSession}` : ""
      return `Waiting for ${status.kind} lock on ${label}${queue}${wait}${owner}`
    }
    if (status.phase === "acquired") return `Acquired ${status.kind} lock for ${label}${wait}`
    if (status.phase === "stale_reaped") {
      const owner = status.ownerSession ? ` from ${status.ownerSession}` : ""
      return `Reaped stale ${status.kind} lock for ${label}${owner}`
    }
    if (status.phase === "released") {
      const count = status.releasedCount ?? 1
      return `Released ${count} lock${count === 1 ? "" : "s"}`
    }
    return `Timed out waiting for ${status.kind} lock on ${label}${wait}`
  }

  async function notify(status: LockStatus) {
    const message = statusMessage(status)
    const key = `${status.sessionID}:${status.key}:${status.phase}`
    const now = Date.now()

    if (status.phase === "waiting") {
      const prev = waitToastDebounce.get(key) ?? 0
      if (now - prev < 1500) return
      waitToastDebounce.set(key, now)
    }

    await input.client.app
      .log({
        body: {
          service: "session-lock",
          level: status.phase === "timeout" ? "warn" : "info",
          message,
          extra: {
            sessionID: status.sessionID,
            key: status.key,
            kind: status.kind,
            target: status.target,
            queuePosition: status.queuePosition,
            queueLength: status.queueLength,
            ownerSession: status.ownerSession,
            waitMs: status.waitMs,
            releasedCount: status.releasedCount,
          },
        },
      })
      .catch(() => {})

    await input.client.tui
      .showToast({
        body: {
          title: "Session lock",
          message,
          variant: status.phase === "timeout" ? "warning" : status.phase === "released" ? "success" : "info",
          duration: status.phase === "waiting" ? 1400 : 2200,
        },
      })
      .catch(() => {})
  }

  const locks = new SessionLock({ directory: input.directory, lockfile, notify })

  return {
    async "tool.execute.before"(evt, out) {
      const args = out.args as unknown
      if (!isRecord(args)) return

      if (evt.tool === "write" || evt.tool === "edit" || evt.tool === "multiedit") {
        const filePath = typeof args.filePath === "string" ? args.filePath : undefined
        if (!filePath) return
        await locks.file(evt.sessionID, filePath)
        return
      }

      if (evt.tool === "apply_patch") {
        const patchText = typeof args.patchText === "string" ? args.patchText : undefined
        if (!patchText) return
        for (const file of filesFromPatch(input.directory, patchText)) {
          await locks.file(evt.sessionID, file)
        }
        return
      }

      if (evt.tool === "bash") {
        const command = typeof args.command === "string" ? args.command : undefined
        if (!command) return

        const workdir = typeof args.workdir === "string" && args.workdir.length ? args.workdir : undefined
        const cwd = workdir ?? input.directory
        const sideEffect = await gitSideEffects(command).catch(() => fallbackGitSideEffects(command))
        if (!sideEffect) return
        await locks.repo(evt.sessionID, cwd)
      }
    },

    async event({ event }) {
      if (event.type === "session.status" && event.properties?.status?.type === "idle") {
        await locks.releaseSession(event.properties.sessionID).catch(() => {})
      }
      if (event.type === "session.deleted") {
        await locks.releaseSession(event.properties.info.id).catch(() => {})
      }
    },
  }
}

export { SessionLockPlugin }
