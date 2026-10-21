#!/usr/bin/env bun
// Lists the Macs on this LAN that this Mac can SSH into, and checks each one.
// Sources: Bonjour `_ssh._tcp` (every Mac with Remote Login on) and `.local` hosts in ~/.ssh/config.
// Usage: bun list-hosts.ts
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BROWSE_MS = 3000
const RESOLVE_MS = 2000
const SSH_TIMEOUT_S = 5
const DEFAULT_USER = 'tommy'

type Host = {
  hostname: string
  alias?: string
  user?: string
  sources: Set<string>
}

function run(cmd: string, args: string[], { stopAfterMs }: { stopAfterMs?: number } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    // dns-sd never exits on its own. SIGINT makes it flush stdout; SIGTERM loses the buffer.
    const timer = stopAfterMs ? setTimeout(() => child.kill('SIGINT'), stopAfterMs) : undefined
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// dns-sd escapes names like `macbook\03248GB` (\032 is a space)
function unescapeDnsSd(s: string) {
  return s.replace(/\\(\d{3})/g, (_, n) => String.fromCharCode(Number(n)))
}

async function bonjourHosts(): Promise<string[]> {
  const { stdout } = await run('dns-sd', ['-B', '_ssh._tcp', 'local'], { stopAfterMs: BROWSE_MS })
  const instances = new Set<string>()
  for (const line of stdout.split('\n')) {
    const m = line.match(/\sAdd\s+\d+\s+\d+\s+\S+\s+_ssh\._tcp\.\s+(.+)$/)
    if (m) instances.add(m[1].trim())
  }
  const resolved = await Promise.all(
    [...instances].map(async (instance) => {
      const { stdout } = await run('dns-sd', ['-L', instance, '_ssh._tcp', 'local'], { stopAfterMs: RESOLVE_MS })
      const m = stdout.match(/can be reached at (\S+?)\.?:\d+/)
      if (!m) console.error(`bonjour: could not resolve "${instance}"`)
      return m ? unescapeDnsSd(m[1]) : undefined
    }),
  )
  return resolved.filter((h): h is string => !!h)
}

// Only `Host` blocks whose HostName ends in .local: those are LAN machines.
function sshConfigHosts(): Host[] {
  let text = ''
  try {
    text = readFileSync(path.join(os.homedir(), '.ssh/config'), 'utf8')
  } catch {
    return []
  }
  const hosts: Host[] = []
  let current: { aliases: string[]; hostname?: string; user?: string } | undefined
  const flush = () => {
    if (!current?.hostname?.toLowerCase().endsWith('.local')) return
    const alias = current.aliases.find((a) => !a.includes('*') && !a.includes('?'))
    hosts.push({ hostname: current.hostname, alias, user: current.user, sources: new Set(['ssh-config']) })
  }
  for (const raw of text.split('\n')) {
    const [key, ...rest] = raw.trim().split(/\s+/)
    if (!key || key.startsWith('#')) continue
    const k = key.toLowerCase()
    if (k === 'host' || k === 'match') {
      flush()
      current = k === 'host' ? { aliases: rest } : undefined
    } else if (current && k === 'hostname') current.hostname = rest[0]
    else if (current && k === 'user') current.user = rest[0]
  }
  flush()
  return hosts
}

// Account of a Keychain password with service `<host>.local`, preferring account = SSH user.
// Never reads the password itself.
async function keychainAccount(hostname: string, user?: string) {
  if (user && (await run('security', ['find-generic-password', '-a', user, '-s', hostname])).code === 0) return user
  const { code, stdout } = await run('security', ['find-generic-password', '-s', hostname])
  if (code !== 0) return undefined
  return stdout.match(/"acct"<blob>="([^"]*)"/)?.[1] ?? ''
}

async function probe(target: string) {
  const { code, stdout, stderr } = await run('ssh', [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_TIMEOUT_S}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    target,
    'scutil --get ComputerName; whoami; sw_vers -productVersion; uname -m',
  ])
  if (code === 0) {
    const [name, user, macos, arch] = stdout.trim().split('\n')
    return `ok: "${name}", user ${user}, macOS ${macos} ${arch}`
  }
  const err = stderr.trim().split('\n').pop() ?? `exit ${code}`
  if (/Permission denied/.test(err)) return `no key access (${err}). Wrong user, or this Mac's public key is not in authorized_keys`
  if (/Could not resolve hostname/.test(err)) return `offline: .local name does not resolve. Mac off, asleep, or on another network`
  if (/timed out|No route|Host is down/.test(err)) return `unreachable (${err}). Mac asleep, locked, or off this LAN`
  if (/Connection refused/.test(err)) return `refused (${err}). Remote Login is off`
  return `failed: ${err}`
}

async function main() {
  const self = (await run('scutil', ['--get', 'LocalHostName'])).stdout.trim().toLowerCase() + '.local'
  console.error('browsing Bonjour for _ssh._tcp...')
  const hosts = new Map<string, Host>()
  for (const h of sshConfigHosts()) hosts.set(h.hostname.toLowerCase(), h)
  for (const hostname of await bonjourHosts()) {
    const key = hostname.toLowerCase()
    const existing = hosts.get(key)
    if (existing) existing.sources.add('bonjour')
    else hosts.set(key, { hostname, sources: new Set(['bonjour']) })
  }
  hosts.delete(self)
  if (hosts.size === 0) {
    console.log('No other Macs found. Remote Login may be off, or the Macs are asleep or on another network.')
    return
  }
  console.error(`checking ${hosts.size} host(s) over SSH...`)
  const reports = await Promise.all(
    [...hosts.values()].map(async (h) => {
      // No User in ~/.ssh/config: guess the default admin user
      const user = h.user ?? DEFAULT_USER
      const account = await keychainAccount(h.hostname, user)
      const target = h.alias && h.user ? h.alias : `${user}@${h.alias ?? h.hostname}`
      const status = await probe(target)
      const password =
        account === undefined
          ? 'not in Keychain'
          : `in Keychain: security find-generic-password -a ${account} -s ${h.hostname} -w`
      return [
        h.hostname,
        `  ssh:      ssh ${target}`,
        `  status:   ${status}`,
        `  password: ${password}`,
        `  found by: ${[...h.sources].join(', ')}`,
      ].join('\n')
    }),
  )
  console.log(reports.join('\n\n'))
}

main()
