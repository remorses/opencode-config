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

// Chrome UA so Google Fonts answers with woff2
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
// unicode-range subsets to embed; others (latin-ext, cyrillic...) fall back to system fonts to keep the svg small
const FONT_SUBSETS = new Set(['latin'])

// Fetch a stylesheet and everything it imports, with font files as data: urls.
// The result has no external references, so the svg renders inside <img>.
async function inlineCss(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': CHROME_UA } })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  let css = await res.text()

  // Google Fonts marks each @font-face with a /* subset */ comment
  css = css.replace(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{[^}]*}/g, (block, subset: string) =>
    FONT_SUBSETS.has(subset) ? block : '',
  )

  const imports = [...css.matchAll(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)\s*;/g)]
  for (const m of imports) {
    css = css.replace(m[0], await inlineCss(new URL(m[1], url).href))
  }

  const fonts = [...new Set([...css.matchAll(/url\(\s*['"]?([^'")]+\.(?:woff2?|ttf|otf))['"]?\s*\)/g)].map((m) => m[1]))]
  for (const font of fonts) {
    const abs = new URL(font, url).href
    const bytes = Buffer.from(await (await fetch(abs)).arrayBuffer())
    const mime = abs.endsWith('.woff') ? 'font/woff' : abs.endsWith('.ttf') ? 'font/ttf' : 'font/woff2'
    css = css.replaceAll(font, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  return css
}

// Colors of another style for dark mode: its token rules wrapped in a prefers-color-scheme query.
// Fonts stay the base style's, because arrows were laid out with those metrics.
async function darkCss(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  const css = (await res.text())
    .replace(/@import[^;]+;/g, '')
    .replace(/^\s*--(sans|mono):[^;]*;\s*$/gm, '')
  return `@media (prefers-color-scheme: dark) {\n${css}\n}`
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

      The image type comes from the \`--out\` extension: png, jpg or svg.
      svg wraps the rendered html in a <foreignObject> with the css and fonts
      embedded, so it stays sharp at any size and needs no network. Add
      \`--dark nextjs-style\` to make one svg that follows light and dark mode.
    `,
  )
  .option('-o, --out [path]', z.string().optional().describe('Output image path (default: <html name>.png next to the html)'))
  .option('--id [id]', z.string().default('diagram').describe('Id of the element to screenshot'))
  .option('--scale [scale]', z.number().default(2).describe('Device pixel ratio of the output image'))
  .option('--width [width]', z.number().default(1600).describe('Viewport width in css px'))
  .option('--dark [style]', z.string().optional().describe('svg only: switch to the colors of this style (e.g. nextjs-style) when the viewer is in dark mode'))
  .example('# Render the default #diagram element at 2x')
  .example('bun ~/.config/opencode/skills/diagrams-and-charts/render.ts render chart.html -o ./chart.png')
  .example('# One svg for light and dark mode (light: the page style, dark: nextjs-style colors)')
  .example('bun ~/.config/opencode/skills/diagrams-and-charts/render.ts render chart.html -o ./chart.svg --dark nextjs-style')
  .action(async (htmlArg, options, { console }) => {
    const htmlPath = path.resolve(htmlArg)
    if (!fs.existsSync(htmlPath)) {
      throw new Error(`File not found: ${htmlPath}`)
    }
    const outPath = path.resolve(options.out || htmlPath.replace(/\.html?$/i, '') + '.png')
    const ext = path.extname(outPath).toLowerCase()
    const type = ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.svg' ? 'svg' : undefined
    if (!type) {
      throw new Error(`Unsupported output type "${ext}". Use .png, .jpg or .svg: render ${htmlArg} -o out.png`)
    }
    if (options.dark && type !== 'svg') {
      throw new Error(`--dark only works for svg output: render ${htmlArg} -o out.svg --dark ${options.dark}`)
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
      if (type === 'svg') {
        const { width, height, markup, sheets } = await target.evaluate((root) => {
          const box = root.getBoundingClientRect()
          // pin the size: text metrics inside <img> can differ by a pixel and leave a gap
          const pinSize = (el: Element, r: DOMRect) => {
            const clone = el.cloneNode(true) as HTMLElement
            clone.style.width = `${r.width}px`
            clone.style.height = `${r.height}px`
            return clone
          }
          return {
            width: Math.ceil(box.width),
            height: Math.ceil(box.height),
            markup: new XMLSerializer().serializeToString(pinSize(root, box)),
            sheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href),
          }
        })
        const inlineStyles = await page.evaluate(() => [...document.querySelectorAll('style')].map((s) => s.textContent ?? ''))
        const dark = options.dark ? [await darkCss(`${server.url.origin}/skill/${options.dark}/style.css`)] : []
        const css = [...(await Promise.all(sheets.map(inlineCss))), ...inlineStyles, ...dark].join('\n')
        const svg = [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
          `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
          `<div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${css.replaceAll(']]>', ']]]]><![CDATA[>')}]]></style>${markup}</div>`,
          '</foreignObject></svg>',
        ].join('')
        fs.writeFileSync(outPath, svg)
      } else {
        await target.screenshot({ path: outPath, type, scale: 'device', animations: 'disabled' })
      }
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
