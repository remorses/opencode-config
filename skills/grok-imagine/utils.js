async function onGrokPage({ page }) {
  if (!String(page.url()).includes('grok.com')) {
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' })
  }
}

export async function getImagineQuota({ page }) {
  await onGrokPage({ page })
  const result = await page.evaluate(async () => {
    const res = await fetch('/rest/media/imagine/quota_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: '{}',
    })
    const text = await res.text()
    return { status: res.status, text }
  })
  if (result.status === 401 || result.status === 403) {
    throw new Error('Not signed in on grok.com. Open grok.com/imagine and log in.')
  }
  if (result.status !== 200) {
    throw new Error(`quota_info failed: ${result.status} ${result.text}`)
  }
  return JSON.parse(result.text)
}

export async function generateImagineImage({
  page,
  prompt,
  aspectRatio = '16:9',
  count = 1,
}) {
  if (!prompt) {
    throw new Error('prompt is required')
  }
  const quota = await getImagineQuota({ page })
  if (!quota.image?.available) {
    throw new Error('Imagine image quota is not available')
  }
  return await page.evaluate(
    async ({ prompt, aspectRatio, count }) => {
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://grok.com/ws/imagine/listen')
        const jobs = {}
        const timer = setTimeout(() => {
          ws.close()
          reject(new Error('imagine websocket timed out'))
        }, 90000)
        ws.onopen = () => {
          const timestamp = Date.now()
          ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              timestamp,
              item: { type: 'message', content: [{ type: 'reset' }] },
            }),
          )
          ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              timestamp,
              item: {
                type: 'message',
                content: [
                  {
                    requestId: crypto.randomUUID(),
                    text: prompt,
                    type: 'input_text',
                    properties: {
                      section_count: 0,
                      is_kids_mode: false,
                      enable_nsfw: false,
                      skip_upsampler: false,
                      enable_side_by_side: true,
                      is_initial: false,
                      aspect_ratio: aspectRatio,
                      enable_pro: false,
                      num_generations: count,
                    },
                  },
                ],
              },
            }),
          )
        }
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'json' && msg.job_id) {
            jobs[msg.job_id] = {
              ...(jobs[msg.job_id] || {}),
              status: msg.current_status,
              percent: msg.percentage_complete,
            }
          }
          const done = Object.values(jobs).filter((job) => {
            return job.status === 'completed'
          })
          if (done.length >= count) {
            clearTimeout(timer)
            ws.close()
            resolve({
              prompt,
              aspectRatio,
              images: Object.keys(jobs).map((id) => {
                return {
                  id,
                  status: jobs[id].status,
                  url: `https://imagine-public.x.ai/imagine-public/images/${id}.jpg`,
                }
              }),
            })
          }
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('imagine websocket error'))
        }
      })
    },
    { prompt, aspectRatio, count },
  )
}

// ---------------------------------------------------------------------------
// Video SDK (grok.com/imagine, Video mode). Recorded from the UI with playwriter.
//
//   const pages = await getGrokPages({ context, count: 3 })          // parallel tabs
//   const jobs = await Promise.all(prompts.map((p, i) =>
//     startImagineVideo({ page: pages[i % pages.length], prompt: p }))) // fast, returns ids
//   const done = await Promise.all(jobs.map((j) => waitImagineVideo(j))) // poll until ready
//   await downloadImagineVideo({ ...done[0], outPath: '/abs/out.mp4' })  // save mp4
//
// Transport: POST /rest/app-chat/conversations/new streams NDJSON progress
// (result.response.streamingVideoGenerationResponse). The stream is read inside
// the tab and kept in window.__grokJobs[id]; wait/download read it from there.
// Generate on https://grok.com/robots.txt tabs, never on /imagine: the app
// soft-navigates mid-request and destroys page.evaluate.
// ---------------------------------------------------------------------------

const STATIC_URL = 'https://grok.com/robots.txt'

// Open `count` static grok.com tabs (reuses ones this helper opened before).
// Several tabs generate in parallel; ~5 concurrent generations is the limit,
// above that Grok answers with empty streams.
export async function getGrokPages({ context, count = 1 }) {
  const pages = context.pages().filter((p) => p.url() === STATIC_URL)
  while (pages.length < count) {
    const page = await context.newPage()
    await page.goto(STATIC_URL, { waitUntil: 'domcontentloaded' })
    pages.push(page)
  }
  return pages.slice(0, count)
}

// Upload a local image. Returns the asset id used as an `inputAssets` entry.
export async function uploadImagineFile({ page, path }) {
  const { readFileSync } = await import('node:fs')
  const { basename, extname } = await import('node:path')
  const ext = extname(path).slice(1).toLowerCase().replace('jpg', 'jpeg')
  const base64 = readFileSync(path).toString('base64')
  const result = await page.evaluate(
    async ({ base64, name, mime }) => {
      const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const fd = new FormData()
      fd.append('file', new Blob([bin], { type: mime }), name)
      const res = await fetch('/http/upload-file-v2/direct', { method: 'POST', credentials: 'include', body: fd })
      return { status: res.status, text: await res.text() }
    },
    { base64, name: basename(path), mime: `image/${ext}` },
  )
  if (result.status !== 200) throw new Error(`upload failed: ${result.status} ${result.text.slice(0, 300)}`)
  return JSON.parse(result.text).fileMetadata.fileMetadataId
}

// Start a generation and return at once with { id, page }. Does not wait for the video.
// - no imagePaths: text to video
// - 1 image: image to video (image is the first frame)
// - 2+ images: reference to video (style/subject references)
// resolution "480p" (draft, ~20-40s) or "720p"; duration 6, 10 or 15 seconds.
export async function startImagineVideo({ page, prompt, imagePaths = [], aspectRatio = '16:9', duration = 6, resolution = '480p' }) {
  if (!prompt) throw new Error('prompt is required')
  const inputAssets = []
  for (const path of imagePaths) inputAssets.push(await uploadImagineFile({ page, path }))
  const common = { prompt, aspectRatio, duration, resolutionName: resolution }
  const mediaGenInput =
    inputAssets.length === 0
      ? { textToVideo: common }
      : inputAssets.length === 1
        ? { imageToVideo: { ...common, inputAssets, mode: 'custom' } }
        : { referenceToVideo: { ...common, inputAssets } }
  const id = `job_${Math.random().toString(36).slice(2, 10)}`
  await page.evaluate(
    ({ id, prompt, mediaGenInput }) => {
      window.__grokJobs ??= {}
      const job = (window.__grokJobs[id] = { text: '', done: false, status: 0 })
      fetch('/rest/app-chat/conversations/new', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelName: 'imagine-video-gen',
          message: `${prompt} --mode=custom`,
          enableImageStreaming: true,
          enableSideBySide: true,
          sendFinalMetadata: true,
          responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } },
          mediaGenInput,
          kind: 'CONVERSATION_KIND_IMAGINE',
        }),
      })
        .then(async (res) => {
          job.status = res.status
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            job.text += dec.decode(value)
          }
          job.done = true
        })
        .catch((e) => {
          job.err = String(e)
          job.done = true
        })
    },
    { id, prompt, mediaGenInput },
  )
  return { id, page, prompt }
}

function parseJob(job) {
  let progress = 0
  let video
  for (const line of job.text.split('\n')) {
    if (!line.trim()) continue
    let v
    try {
      v = JSON.parse(line)?.result?.response?.streamingVideoGenerationResponse
    } catch {
      continue // partial last line
    }
    if (!v) continue
    progress = Math.max(progress, v.progress ?? 0)
    if (v.moderated) return { progress, error: 'video was moderated' }
    if (v.videoUrl) video = v
  }
  return { progress, video }
}

// Current state without blocking: { progress, done, video?, error? }
export async function getImagineVideoStatus({ page, id }) {
  const job = await page.evaluate((id) => window.__grokJobs?.[id] ?? null, id)
  if (!job) return { progress: 0, done: true, error: 'unknown job id (page reloaded?)' }
  const { progress, video, error } = parseJob(job)
  if (error) return { progress, done: true, error }
  if (job.done && !video) {
    return { progress, done: true, error: job.err || `no video in response (status ${job.status}): ${job.text.slice(-200)}` }
  }
  return { progress, done: !!video, video }
}

// Poll until the video is ready. Returns { id, page, videoUrl, videoId, width, height, resolution }.
export async function waitImagineVideo({ page, id, timeoutMs = 300000, onProgress }) {
  const start = Date.now()
  while (true) {
    const s = await getImagineVideoStatus({ page, id })
    if (s.error) throw new Error(s.error)
    if (s.video) {
      const v = s.video
      return { id, page, videoUrl: v.videoUrl, videoId: v.videoId, width: v.width, height: v.height, resolution: v.resolutionName }
    }
    if (onProgress) onProgress(s.progress)
    if (Date.now() - start > timeoutMs) throw new Error('video generation timed out')
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// Save the mp4. assets.grok.com needs the page cookies (plain curl gets 403).
export async function downloadImagineVideo({ page, videoUrl, outPath }) {
  const { writeFileSync } = await import('node:fs')
  const base64 = await page.evaluate(async (url) => {
    const res = await fetch(`https://assets.grok.com/${url}`, { credentials: 'include' })
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  }, videoUrl)
  writeFileSync(outPath, Buffer.from(base64, 'base64'))
  return outPath
}

// Convenience: start + wait + download one clip.
export async function generateImagineVideo({ outPath, onProgress, timeoutMs, ...opts }) {
  const job = await startImagineVideo(opts)
  const done = await waitImagineVideo({ ...job, timeoutMs, onProgress })
  await downloadImagineVideo({ page: job.page, videoUrl: done.videoUrl, outPath })
  return { ...done, outPath }
}
