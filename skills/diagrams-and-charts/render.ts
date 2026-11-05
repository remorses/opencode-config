#!/usr/bin/env bun
// Render an HTML diagram to an image through the user's Chrome (playwriter extension).
// Serves the html folder over http, opens a tab, screenshots #<id>, saves it, closes the tab.

import fs from 'node:fs'
import path from 'node:path'
import { goke } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import { connectViaExtension, getCDPSessionForPage } from 'playwriter'

const SKILL_DIR = import.meta.dirname

const transpiler = new Bun.Transpiler({ loader: 'ts' })

// `/skill/*` maps to this skill folder so any html can link `/skill/claude-style/style.css`.
// Everything else maps to the folder of the html file. `.ts` files are served as transpiled js.
function startServer({ root }: { root: string }) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(req.url).pathname)
      } catch {
        return new Response('invalid url', { status: 400 })
      }
      const [base, rel] = pathname.startsWith('/skill/')
        ? [SKILL_DIR, pathname.slice('/skill/'.length)]
        : [root, pathname.slice(1)]
      const file = path.resolve(base, rel)
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response('not found', { status: 404 })
      }
      const headers = { 'cache-control': 'no-store' }
      if (file.endsWith('.ts')) {
        const js = transpiler.transformSync(await Bun.file(file).text())
        return new Response(js, { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } })
      }
      return new Response(Bun.file(file), { headers })
    },
  })
}

// Colors of another style: its token rules without its fonts, because arrows were laid out
// with the page style's font metrics.
async function colorsCss(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return (await res.text()).replace(/@import[^;]+;/g, '').replace(/^\s*--(sans|mono):[^;]*;\s*$/gm, '')
}

const cli = goke('diagram')

cli
  .command(
    'render <html>',
    dedent`
      Render one element of an html file to an image.

      Serves the html folder on a random localhost port, opens a tab in the
      playwriter-connected Chrome, waits for network idle, fonts and the
      drawing helpers, fails on page errors, screenshots the element
      with id \`--id\`, writes the image, then closes the tab.

      The image type comes from the \`--out\` extension: png or jpg.
      \`--dark nextjs-style\` renders the same layout with that style's colors,
      for the dark mode copy of a light figure.
    `,
  )
  .option('-o, --out [path]', z.string().optional().describe('Output image path (default: <html name>.png next to the html)'))
  .option('--id [id]', z.string().default('diagram').describe('Id of the element to screenshot'))
  .option('--scale [scale]', z.number().default(2).describe('Device pixel ratio of the output image'))
  .option('--width [width]', z.number().default(1600).describe('Viewport width in css px'))
  .option('--dark [style]', z.string().optional().describe('Use the colors of this style (e.g. nextjs-style), keep the layout and fonts'))
  .example('# Render the default #diagram element at 2x')
  .example('bun ~/.config/opencode/skills/diagrams-and-charts/render.ts render chart.html -o ./chart.png')
  .example('# Dark mode copy: same layout, nextjs-style colors')
  .example('bun ~/.config/opencode/skills/diagrams-and-charts/render.ts render chart.html -o ./chart-dark.png --dark nextjs-style')
  .action(async (htmlArg, options, { console }) => {
    const htmlPath = path.resolve(htmlArg)
    if (!fs.existsSync(htmlPath)) {
      throw new Error(`File not found: ${htmlPath}`)
    }
    const outPath = path.resolve(options.out || htmlPath.replace(/\.html?$/i, '') + '.png')
    const ext = path.extname(outPath).toLowerCase()
    const type = ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : undefined
    if (!type) {
      throw new Error(`Unsupported output type "${ext}". Use .png or .jpg: render ${htmlArg} -o out.png`)
    }

    const server = startServer({ root: path.dirname(htmlPath) })
    const url = `${server.url.origin}/${encodeURIComponent(path.basename(htmlPath))}`
    console.error(`serving ${url}`)
    try {
      await using connection = await connectViaExtension({ tabGroup: 'diagrams', tabGroupColor: 'orange' })
      const context = connection.browser.contexts()[0]
      if (!context) throw new Error('No browser context from playwriter')
      await using page = await context.newPage()

      // fixed viewport + DPR so output size does not depend on the user's window or display
      const cdp = await getCDPSessionForPage({ page })
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: options.width,
        height: 1000,
        deviceScaleFactor: options.scale,
        mobile: false,
      })

      const pageErrors: Error[] = []
      page.on('pageerror', (error) => pageErrors.push(error))

      // networkidle covers web fonts and images; fonts.ready covers fonts requested by late layout;
      // __renderTasks covers helpers that draw after fonts load (diagram.ts connect)
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      await page.evaluate(async () => {
        await document.fonts.ready
        const w = window as unknown as { __renderTasks?: Promise<unknown>[] }
        await Promise.all(w.__renderTasks ?? [])
      })
      if (pageErrors.length > 0) {
        throw new Error(`Page errors in ${htmlPath}:\n${pageErrors.map((e) => e.message).join('\n')}`)
      }
      // after the arrows are drawn: the colors change, the layout does not
      if (options.dark) {
        const css = await colorsCss(`${server.url.origin}/skill/${options.dark}/style.css`)
        await page.addStyleTag({ content: css })
      }
      const target = page.locator(`[id="${options.id}"]`)
      if ((await target.count()) === 0) {
        throw new Error(`No element with id="${options.id}" in ${htmlPath}. Wrap the diagram in <div id="${options.id}">.`)
      }
      // the screenshot clips anything outside the target, so name what sticks out
      const overflow = await target.evaluate((root) => {
        const box = root.getBoundingClientRect()
        return [...root.querySelectorAll('*')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1)
          })
          .map((el) => (el.id ? `#${el.id}` : (el.textContent ?? '').trim().slice(0, 40) || el.tagName.toLowerCase()))
          .slice(0, 10)
      })
      if (overflow.length > 0) {
        console.error(`warning: clipped, outside #${options.id}: ${overflow.join(', ')}. Shorten text or use fewer columns.`)
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      await target.screenshot({ path: outPath, type, scale: 'device', animations: 'disabled' })
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      console.error(`saved ${outPath}`)
      console.log(outPath)
    } finally {
      server.stop(true)
    }
  })

cli.help()
cli.completions()

await cli.parse()
// playwright keeps sockets alive after close; the command is done here
process.exit(0)
