// Shared fal.ai helpers for the audio-separation scripts: API key, upload, queue, download.
// Plain fetch on purpose, so the scripts run with `bun` and no install step.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url))
const ENV_PATH = path.join(SKILL_DIR, '.env')
// fal-js switches to multipart above this size. Songs are far smaller.
const MAX_SIMPLE_UPLOAD = 90 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
}

export type FalFile = { url: string; content_type?: string; file_name?: string }

export function log(message: string) {
  console.error(`[fal] ${message}`)
}

/** FAL_KEY from the environment, else from `.env` next to this file. */
export function loadFalKey(): string {
  if (process.env.FAL_KEY) return process.env.FAL_KEY
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const match = line.match(/^\s*FAL_KEY\s*=\s*(.*)\s*$/)
      const value = match?.[1]?.replace(/^['"]|['"]$/g, '')
      if (value) return value
    }
  }
  throw new Error(`FAL_KEY is empty. Add it to ${ENV_PATH} (get one at https://fal.ai/dashboard/keys)`)
}

/** Returns a URL fal can read: URLs pass through, local files are uploaded to fal storage. */
export async function resolveAudioUrl({ input, key }: { input: string; key: string }): Promise<string> {
  if (/^https?:\/\//.test(input)) return input
  const filePath = path.resolve(input)
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_SIMPLE_UPLOAD) {
    throw new Error(`${filePath} is ${Math.round(stat.size / 1e6)} MB. Convert it to mp3 first (ffmpeg -i in -b:a 192k out.mp3)`)
  }
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  log(`uploading ${path.basename(filePath)} (${Math.round(stat.size / 1e5) / 10} MB)`)
  const initiate = await fetch('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: path.basename(filePath) }),
  })
  if (!initiate.ok) throw new Error(`fal upload initiate failed: ${initiate.status} ${await initiate.text()}`)
  const { upload_url, file_url } = (await initiate.json()) as { upload_url: string; file_url: string }
  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: fs.readFileSync(filePath),
  })
  if (!put.ok) throw new Error(`fal upload failed: ${put.status} ${await put.text()}`)
  log(`uploaded ${file_url}`)
  return file_url
}

/** Submits to the fal queue, waits for completion, returns the endpoint output. */
export async function runFal<T>({ endpoint, input, key }: { endpoint: string; input: object; key: string }): Promise<T> {
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }
  const submit = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  })
  if (!submit.ok) throw new Error(`${endpoint} submit failed: ${submit.status} ${await submit.text()}`)
  // Use the returned URLs: nested endpoints (fal-ai/sam-audio/separate) poll under the app id.
  const { request_id, status_url, response_url } = (await submit.json()) as {
    request_id: string
    status_url: string
    response_url: string
  }
  log(`${endpoint} request ${request_id}`)

  const started = Date.now()
  let lastStatus = ''
  while (true) {
    const res = await fetch(status_url, { headers })
    if (!res.ok) throw new Error(`${endpoint} status failed: ${res.status} ${await res.text()}`)
    const { status, queue_position } = (await res.json()) as { status: string; queue_position?: number }
    const line = status === 'IN_QUEUE' ? `${status} (position ${queue_position ?? '?'})` : status
    if (line !== lastStatus) {
      log(`${line} after ${Math.round((Date.now() - started) / 1000)}s`)
      lastStatus = line
    }
    if (status === 'COMPLETED') break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  const result = await fetch(response_url, { headers })
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.status} ${await result.text()}`)
  return (await result.json()) as T
}

export async function download({ file, dest }: { file: FalFile; dest: string }) {
  const res = await fetch(file.url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${file.url}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  log(`saved ${dest}`)
}

/** Output dir and file base name: next to a local input, or cwd for URLs. */
export function outputTarget({ input, out }: { input: string; out?: string }) {
  const isUrl = /^https?:\/\//.test(input)
  const name = isUrl ? new URL(input).pathname : input
  const base = path.basename(name, path.extname(name)) || 'audio'
  const dir = path.resolve(out ?? (isUrl ? '.' : path.dirname(input)))
  return { dir, base }
}
