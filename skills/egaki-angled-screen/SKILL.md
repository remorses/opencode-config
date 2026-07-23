---
name: egaki-angled-screen
repo: remorses/egaki
description: >
  Turn a flat screenshot or video into a cinematic angled product shot with
  true depth-of-field bokeh via egaki <AngledScreen>. Use when the user wants
  an angled screen mockup, tilted UI photo look, product marketing still,
  cinematic DOF on a screenshot, or to export an image/video with the angled
  screen effect. ALWAYS load this skill for those tasks.
---

# egaki angled screen

One-shot: write one MDX file, run `egaki dev`, capture with
`window.egakiSDK.screenshot`.

No `package.json`, no `vite.config`, no `npm install`. The CLI boots Vite
with all deps from its own install (`egaki dev`).

Requires **egaki ≥ 0.10.0** (`egaki dev`, remotion dedupe, safe-mdx prebundle).

## Before anything

1. **Load the playwriter skill** and run `playwriter skill` (full output, never truncate).
2. Use a recent CLI (global or project-local):

```bash
npm install -g egaki@latest   # or: npx egaki@latest dev …
egaki --version               # expect >= 0.10.0
egaki dev --help
```

3. For full `<AngledScreen>` API docs (optional):

```bash
curl -s https://raw.githubusercontent.com/remorses/egaki/main/README.md
```

Never pipe docs through `head`/`tail`.

## Work under `./tmp`

Keep one-off jobs out of the user's git tree:

```bash
mkdir -p tmp/angled-screen-job/public/inputs tmp/angled-exports
grep -qE '^tmp/?$' .gitignore 2>/dev/null || echo 'tmp/' >> .gitignore
```

Never edit tracked example projects for agent jobs. Never commit `tmp/`.

## Drop the asset

```bash
cp /path/to/flat-screenshot.png tmp/angled-screen-job/public/inputs/shot.png
# Discord CDN: always single-quote the full URL
curl -sL -o tmp/angled-screen-job/public/inputs/shot.png 'https://cdn.discordapp.com/attachments/...'
file tmp/angled-screen-job/public/inputs/shot.png   # must be image data, not ASCII/HTML
```

**Only flat inputs.** Already-angled photos are style refs, not sources.

## Write one MDX file

`tmp/angled-screen-job/video.mdx` (dark UI):

```mdx
---
fps: 30
width: 1920
height: 1080
---

# Shot duration=1s

<AngledScreen
  rotateX={10}
  rotateY={-22}
  translateZ={120}
  perspective={800}
  aperture={0.5}
  maxBlur={0.12}
  chromaticAberration={0.55}
  grainIntensity={0.03}
  fog={0.35}
  backgroundColor="#040406"
  width="88%"
  height="auto"
>
  <img
    src="/inputs/shot.png"
    style={{
      width: '100%',
      display: 'block',
      borderRadius: 14,
      border: '1px solid rgba(255,255,255,0.12)',
      boxSizing: 'border-box',
    }}
  />
</AngledScreen>
```

**Light / white page:** `backgroundColor="#ffffff"`, lower `fog` and
`grainIntensity`. Never put a white UI on a black stage.

**Video input:** replace `<img>` with:

```mdx
<Video
  src="/inputs/clip.mp4"
  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
/>
```

and use a real duration (e.g. `duration=5s`).

`<AngledScreen>` and `<Video>` are MDX builtins — no imports.

## Start the player

```bash
egaki dev tmp/angled-screen-job/video.mdx
# prints a Local URL on a free port, e.g. http://localhost:5199/
```

Or from inside the folder:

```bash
cd tmp/angled-screen-job && egaki dev
```

Note the URL. Wait until it is serving before capturing.

## Capture with playwriter + egakiSDK

```bash
playwriter session new
# if multiple browsers listed: playwriter session new --browser <key>
# use the session id from session new (examples use -s 1)
```

```bash
playwriter -s 1 --timeout 120000 -e 'await page.goto("http://localhost:5199/", { waitUntil: "domcontentloaded", timeout: 60000 })'
# wait until PlayerPage has registered the composition (SDK exists earlier)
playwriter -s 1 --timeout 120000 -e 'await page.waitForFunction(() => { try { return window.egakiSDK.getInfo().sectionCount > 0 } catch { return false } }, { timeout: 90000 })'
playwriter -s 1 -e 'console.log(JSON.stringify(await page.evaluate(() => window.egakiSDK.getInfo()), null, 2))'
```

Replace the port with whatever `egaki dev` printed. Wait ~1s after load so
the shader paints. A `Mediabunny was loaded twice` console warning is harmless
for still screenshots.

### Screenshot 1x (mid-frame of a 1s section @ 30fps = frame 15)

```bash
playwriter -s 1 --timeout 120000 -e "$(cat <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const outDir = path.resolve('tmp/angled-exports')
fs.mkdirSync(outDir, { recursive: true })
const dataUrl = await page.evaluate(async () => {
  return await window.egakiSDK.screenshot({ frame: 15 })
})
const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
const out = path.join(outDir, 'angled.png')
fs.writeFileSync(out, buf)
console.log('wrote', out, buf.length)
EOF
)"
```

Run playwriter from the **workspace root** so `tmp/angled-exports` resolves.
Or use an absolute path.

### Higher definition (2x → 3840×2160 from 1920×1080)

```bash
playwriter -s 1 --timeout 180000 -e "$(cat <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const outDir = path.resolve('tmp/angled-exports')
fs.mkdirSync(outDir, { recursive: true })
const dataUrl = await page.evaluate(async () => {
  return await window.egakiSDK.screenshot({ frame: 15, scale: 2 })
})
const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
const out = path.join(outDir, 'angled-2x.png')
fs.writeFileSync(out, buf)
console.log('png', buf.readUInt32BE(16), 'x', buf.readUInt32BE(20), out)
EOF
)"
```

Always use **`window.egakiSDK.screenshot`**, not a browser viewport screenshot.

### Export video (optional)

```bash
playwriter -s 1 --timeout 600000 -e "$(cat <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const outDir = path.resolve('tmp/angled-exports')
fs.mkdirSync(outDir, { recursive: true })
const dataUrl = await page.evaluate(async () => {
  return await window.egakiSDK.export({ frameRange: [0, 149], scale: 1 })
})
const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
fs.writeFileSync(path.join(outDir, 'angled.mp4'), buf)
console.log('wrote', buf.length)
EOF
)"
```

`export` returns a data URL — write it to disk. Prefer `scale: 1` for video.

## Prop starters

| Look | Key props |
|---|---|
| Classic left-recede | `rotateX={10}` `rotateY={-22}` `translateZ={100–150}` |
| Mirrored right-recede | `rotateY={20–24}` (positive) |
| Close / dramatic | lower `perspective` (650–800), higher `translateZ` |
| Softer DOF | lower `aperture` / `maxBlur`, set explicit `focus` (0–1 × perspective) |
| Film look | `chromaticAberration={0.5–0.7}` `grainIntensity={0.03–0.2}` |

Tweakpane is live in the player. Bake final values into the MDX.

## After MDX edits

```bash
playwriter -s 1 --timeout 120000 -e 'await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction(() => window.egakiSDK && window.egakiSDK.getInfo()?.sectionCount > 0, { timeout: 60000 })'
```

## Deliver

1. `file tmp/angled-exports/angled-2x.png` — real PNG, expected size
2. **Read the image** (vision) before sending to the user
3. Upload if needed

## QA

- Near edge sharp, far edge soft
- CA only in the blur, not a full-frame prism
- Stage color matches the page
- Output from `egakiSDK.screenshot`, not a raw page shot
- Hero stills use `scale: 2`
