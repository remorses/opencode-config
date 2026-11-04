#!/usr/bin/env bun
// Search and download sound effects from Openverse (api.openverse.org, no key needed).
// Run with secrets for higher rate limits: sigillo run -p 01M6KWJ82P6XSS7M4YWTK5HSWW -c dev -- bun openverse.ts ...
//
// Run through sigillo for the token (works anonymously too, only slower):
//   sigillo run -p 01M6KWJ82P6XSS7M4YWTK5HSWW -c dev -- bun openverse.ts search ...
//
//   bun openverse.ts search "soft ui pop" [--license cc0] [--max-ms 2000] [--n 12] [--page 2]
//   bun openverse.ts get <id> <out.mp3> [--credits CREDITS.md]
//   bun openverse.ts reel <out.mp4> <file1> <file2> ...   (audition video + start times, for Gemini)

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

const API = 'https://api.openverse.org/v1/audio'
const TIMEOUT_MS = 20_000
const REEL_GAP_S = 0.6

type Audio = {
  id: string
  title: string
  duration: number | null
  license: string
  license_version: string
  creator: string
  provider: string
  url: string
  foreign_landing_url: string
  attribution: string
  tags: { name: string }[]
}

function flag(args: string[], name: string, fallback?: string) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

// Anonymous requests: page_size <= 20 and a low rate limit (Cloudflare answers 429 with an HTML
// challenge after a burst). With OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET set (Sigillo org
// skills, project sound-effects, see SKILL.md) every call uses a bearer token.
const PAGE_SIZE = 20

let token: Promise<string | undefined> | undefined
async function bearer() {
  const id = process.env.OPENVERSE_CLIENT_ID
  const secret = process.env.OPENVERSE_CLIENT_SECRET
  if (!id || !secret) return undefined
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  const res = await fetch(`https://api.openverse.org/v1/auth_tokens/token/`, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) return undefined // anonymous still works, only slower
  const { access_token } = (await res.json()) as { access_token: string }
  return access_token
}

async function api<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { 'user-agent': 'sound-effects-skill' }
  const auth = await (token ??= bearer())
  if (auth) headers.authorization = `Bearer ${auth}`
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers })
  if (res.status === 429) throw new Error('Openverse rate limit (429). Wait a few minutes, search less often, or run through sigillo (see the top of openverse.ts).')
  if (!res.ok) throw new Error(`Openverse ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() as Promise<T>
}

async function search(args: string[]) {
  const q = args[0]
  if (!q) throw new Error('usage: search "<query>" [--license cc0] [--max-ms 2000] [--n 12]')
  const license = flag(args, 'license', 'cc0')!
  const maxMs = Number(flag(args, 'max-ms', '4000'))
  const n = Number(flag(args, 'n', '12'))
  const params = new URLSearchParams({ q, license, page_size: String(PAGE_SIZE), page: flag(args, 'page', '1')! })
  const { results } = await api<{ results: Audio[] }>(`/?${params}`)
  const fits = results.filter((r) => r.duration != null && r.duration <= maxMs).slice(0, n)
  for (const r of fits) {
    const tags = r.tags.slice(0, 6).map((t) => t.name).join(',')
    console.log(`${r.id}  ${(r.duration! / 1000).toFixed(2)}s  ${r.license}  "${r.title}" by ${r.creator}  [${tags}]`)
  }
  if (fits.length === 0) console.log(`no results under ${maxMs} ms; try another query or --max-ms`)
}

async function get(args: string[]) {
  const [id, out] = args
  if (!id || !out) throw new Error('usage: get <id> <out.mp3> [--credits CREDITS.md]')
  const r = await api<Audio>(`/${id}/`)
  const res = await fetch(r.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`download ${res.status} ${r.url}`)
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  console.log(`saved ${out} (${r.title}, ${r.license})`)
  const credits = flag(args, 'credits')
  if (credits) {
    if (!existsSync(credits)) writeFileSync(credits, '# Sound credits\n\nSound effects found on Openverse (api.openverse.org).\n\n')
    appendFileSync(credits, `- \`${out.split('/').pop()}\`: ${r.attribution} Source: ${r.foreign_landing_url}\n`)
  }
}

// One video (black frame + audio) that plays the files one after another with a gap, and the
// start time of each, so a model with audio input (Gemini) can listen and rate them.
function reel(args: string[]) {
  const [out, ...files] = args
  if (!out || files.length === 0) throw new Error('usage: reel <out.mp4> <file1> <file2> ...')
  const inputs = files.flatMap((f) => ['-i', f])
  // input 0 is the black video, the files are inputs 1..n
  const parts = files.map((_, k) => `[${k + 1}:a]aresample=44100,aformat=channel_layouts=stereo,apad=pad_dur=${REEL_GAP_S}[a${k}]`)
  const concat = `${files.map((_, k) => `[a${k}]`).join('')}concat=n=${files.length}:v=0:a=1[a]`
  const p = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10', ...inputs, '-filter_complex', `${parts.join(';')};${concat}`, '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', out], { stdio: 'inherit' })
  if (p.status !== 0) throw new Error('ffmpeg failed')
  let t = 0
  for (const f of files) {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' })
    console.log(`${t.toFixed(2)}s  ${f.split('/').pop()}`)
    t += Number(probe.stdout.trim()) + REEL_GAP_S
  }
  console.log(`saved ${out}`)
}

const [command, ...rest] = process.argv.slice(2)
const commands: Record<string, (args: string[]) => unknown> = { search, get, reel }
if (!command || !commands[command]) {
  console.log('commands: search, get, reel (see the top of openverse.ts)')
  process.exit(1)
}
try {
  await commands[command](rest)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
