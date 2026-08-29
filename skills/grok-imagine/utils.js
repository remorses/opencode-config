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
