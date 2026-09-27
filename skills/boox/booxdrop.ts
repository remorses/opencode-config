#!/usr/bin/env bun
// Find a Boox running BooxDrop on the LAN and upload files to it.
// Usage:
//   bun booxdrop.ts find
//   bun booxdrop.ts send <file...> [--dir /storage/emulated/0/Books] [--url http://ip:8085]
// BooxDrop API (from fmcurti/calibre-booxdrop):
//   GET  /api/device          -> {"type":"server","model":...}
//   POST /api/storage/upload  multipart: file (+ optional dir). Default dir is Books.

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 8085
const PROBE_TIMEOUT_MS = 800
const CONCURRENCY = 128
const CACHE_FILE = path.join(os.homedir(), '.cache', 'booxdrop.json')

type DeviceInfo = { type?: string; model?: string; [key: string]: unknown }
type Hit = { url: string; info: DeviceInfo }

async function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Hit | undefined> {
  try {
    const res = await fetch(`${url}/api/device`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const info = (await res.json()) as DeviceInfo
    if (info?.type !== 'server' || !info.model) return undefined
    return { url, info }
  } catch {
    return undefined
  }
}

// Private IPv4 addresses of this machine, one per /24.
function localSubnets(): string[] {
  const prefixes = new Set<string>()
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Skip VPN tunnels; BooxDrop only lives on the Wi-Fi/Ethernet LAN.
    if (/^(utun|ipsec|ppp|tun|tap|wg|bridge|vmnet|docker|veth)/.test(name)) continue
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue
      prefixes.add(a.address.split('.').slice(0, 3).join('.'))
    }
  }
  return [...prefixes]
}

function readCache(): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).url
  } catch {
    return undefined
  }
}

function writeCache(url: string) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ url, savedAt: new Date().toISOString() }))
}

async function scan(): Promise<Hit[]> {
  const subnets = localSubnets()
  if (subnets.length === 0) {
    console.error('no private IPv4 interface found. Is Wi-Fi on?')
    return []
  }
  const urls = subnets.flatMap((p) =>
    Array.from({ length: 254 }, (_, i) => `http://${p}.${i + 1}:${PORT}`),
  )
  console.error(`scanning ${subnets.map((p) => `${p}.0/24`).join(', ')} on :${PORT} (${urls.length} hosts)`)
  const hits: Hit[] = []
  let next = 0
  async function worker() {
    while (next < urls.length) {
      const hit = await probe(urls[next++]!)
      if (hit) {
        console.error(`found ${hit.info.model} at ${hit.url}`)
        hits.push(hit)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return hits
}

async function find(explicitUrl?: string): Promise<Hit | undefined> {
  if (explicitUrl) {
    console.error(`probing ${explicitUrl}`)
    return probe(explicitUrl.replace(/\/$/, ''), 3000)
  }
  const cached = readCache()
  if (cached) {
    console.error(`trying cached ${cached}`)
    const hit = await probe(cached, 1500)
    if (hit) return hit
    console.error('cached url did not answer, scanning')
  }
  const hits = await scan()
  const hit = hits[0]
  if (hit) writeCache(hit.url)
  return hit
}

async function upload(baseUrl: string, filePath: string, dir?: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) throw new Error(`file not found: ${filePath}`)
  const form = new FormData()
  if (dir) form.append('dir', dir)
  form.append('file', file, path.basename(filePath))
  const mb = (file.size / 1024 / 1024).toFixed(2)
  console.error(`uploading ${path.basename(filePath)} (${mb} MB) to ${baseUrl}`)
  const res = await fetch(`${baseUrl}/api/storage/upload`, { method: 'POST', body: form })
  const text = await res.text()
  let payload: { successful?: boolean; message?: string } = {}
  try {
    payload = JSON.parse(text || '{}')
  } catch {}
  if (!res.ok || payload.successful === false) {
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  console.error(`saved on device: ${payload.message ?? '(no path returned)'}`)
}

function parseArgs(argv: string[]) {
  const files: string[] = []
  let dir: string | undefined
  let url: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dir') dir = argv[++i]
    else if (a === '--url') url = argv[++i]
    else files.push(a)
  }
  return { files, dir, url }
}

const [cmd, ...rest] = process.argv.slice(2)
const { files, dir, url } = parseArgs(rest)

if (cmd !== 'find' && cmd !== 'send') {
  console.error('usage: bun booxdrop.ts find | send <file...> [--dir <device dir>] [--url http://ip:8085]')
  process.exit(2)
}

const hit = await find(url)
if (!hit) {
  console.error('no BooxDrop found. Open BooxDrop on the Boox and use the same Wi-Fi.')
  process.exit(1)
}
if (url) writeCache(hit.url)
console.log(JSON.stringify({ url: hit.url, model: hit.info.model }))

if (cmd === 'send') {
  if (files.length === 0) {
    console.error('send needs at least one file')
    process.exit(2)
  }
  for (const f of files) await upload(hit.url, f, dir)
}
