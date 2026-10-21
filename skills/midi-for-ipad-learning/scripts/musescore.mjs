// MuseScore search + MIDI download, run inside a playwriter session.
// The score MIDI comes from /api/jmuse; its Authorization header is
// md5(`${id}midi0${suffix}`).slice(0, 4), with `suffix` found in MuseScore's
// build JS as `"<suffix>").substr(0,4)`. Same method as LibreScore/dl-librescore.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function searchMusescore({ page, query }) {
  const url = `https://musescore.com/sheetmusic?text=${encodeURIComponent(query)}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('a[href*="/scores/"]', { timeout: 15000 })
  // one card has several links (badge, title); keep the longest text as title
  return page.evaluate(() => {
    const byUrl = new Map()
    for (const a of document.querySelectorAll('a[href*="/scores/"]')) {
      const url = a.href.split('?')[0]
      if (!/\/scores\/\d+$/.test(url)) continue
      const text = a.textContent.trim().replace(/\s+/g, ' ')
      const r = byUrl.get(url) ?? { url, title: '', official: false }
      if (/^Official/.test(text)) r.official = true
      if (text.length > r.title.length) r.title = text
      byUrl.set(url, r)
    }
    return [...byUrl.values()]
  })
}

export async function downloadMusescoreMidi({ page, url, outputPath }) {
  const id = url.match(/\/scores\/(\d+)/)?.[1]
  if (!id) throw new Error(`No score id in ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  const buildUrls = await page.evaluate(() =>
    [...document.querySelectorAll('link[href],script[src]')]
      .map((el) => el.href || el.src)
      .filter((u) => /static\/public\/build/.test(u)),
  )
  const suffixes = new Set()
  for (const u of buildUrls) {
    const text = await page.evaluate(async (u) => (await fetch(u)).text(), u)
    for (const m of text.matchAll(/"([^"]+)"\)\.substr\(0,4\)/g)) suffixes.add(m[1])
  }

  for (const suffix of suffixes) {
    const auth = crypto.createHash('md5').update(`${id}midi0${suffix}`).digest('hex').slice(0, 4)
    const info = await page.evaluate(
      async ({ id, auth }) => {
        const res = await fetch(`/api/jmuse?id=${id}&type=midi&index=0`, { headers: { Authorization: auth } })
        return res.ok ? (await res.json()).info : null
      },
      { id, auth },
    )
    if (!info?.url) continue
    const res = await fetch(info.url)
    if (!res.ok) throw new Error(`MIDI download failed: ${res.status}`)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, Buffer.from(await res.arrayBuffer()))
    return outputPath
  }
  throw new Error(`No working jmuse auth for score ${id}. Suffixes tried: ${[...suffixes].join(', ')}`)
}
