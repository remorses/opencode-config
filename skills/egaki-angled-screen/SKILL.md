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

One-shot: scaffold a tiny egaki project under `./tmp/`, wrap a flat image or
video in `<AngledScreen>`, run the player, capture with
`window.egakiSDK.screenshot` (or `.export` for video).

Works on **any machine**. Do not assume a monorepo or preinstalled examples.

## Before anything

1. **Load the playwriter skill** and run `playwriter skill` (full output, never truncate).
2. Fetch the egaki README in full for API details:

```bash
curl -s https://raw.githubusercontent.com/remorses/egaki/main/README.md
```

Never pipe docs through `head`/`tail`. Canonical `<AngledScreen>` docs are under
`## <AngledScreen>` in that README.

## Work in `./tmp` (never pollute the user repo)

```bash
mkdir -p tmp/angled-screen-job/public/inputs tmp/angled-exports
grep -qE '^tmp/?$' .gitignore 2>/dev/null || echo 'tmp/' >> .gitignore
cd tmp/angled-screen-job
```

Never edit the user's tracked source for one-off jobs. Never commit `tmp/`.

## Scaffold — write these files

### `package.json`

```json
{
  "name": "angled-screen-job",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite"
  },
  "dependencies": {
    "@remotion/media": "4.0.494",
    "@remotion/player": "4.0.494",
    "egaki": "^0.9.0",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "remotion": "4.0.494"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vite": "^8.0.0"
  }
}
```

Pin **remotion / @remotion/** to the same line egaki ships
(`npm view egaki dependencies`). Bump `egaki` with `npm view egaki version`
when this skill drifts. egaki needs **vite >= 8**.

### `vite.config.ts`

```ts
import { defineConfig } from 'vite'
import { video } from 'egaki/vite'

export default defineConfig({
  plugins: [video({ entry: './video.mdx' })],
})
```

### `egaki-env.d.ts`

```ts
import 'egaki/mdx-components'
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx", "**/*.d.ts", "**/*.mdx"]
}
```

### `video.mdx` (dark UI)

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

## Install and run

```bash
cd tmp/angled-screen-job
pnpm install   # or: npm install
pnpm dev
# note the Local URL — port may not be 5173
```

## Drop the asset

```bash
cp /path/to/flat-screenshot.png public/inputs/shot.png
# Discord CDN: always single-quote the full URL
curl -sL -o public/inputs/shot.png 'https://cdn.discordapp.com/attachments/...'
file public/inputs/shot.png   # must be image data, not ASCII/HTML
```

**Only flat inputs.** Already-angled photos are style refs, not sources.

## Capture with playwriter + egakiSDK

```bash
playwriter session new
# if multiple browsers listed: playwriter session new --browser <key>
# use the session id from session new (examples use -s 1)
```

```bash
playwriter -s 1 --timeout 120000 -e 'await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 60000 })'
playwriter -s 1 --timeout 120000 -e 'await page.waitForFunction(() => window.egakiSDK && typeof window.egakiSDK.getInfo === "function", { timeout: 90000 })'
playwriter -s 1 -e 'console.log(JSON.stringify(await page.evaluate(() => window.egakiSDK.getInfo()), null, 2))'
```

Replace the port with whatever `pnpm dev` printed. Wait ~1s after load so the
shader paints.

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

Tweakpane is live in the player. Bake final values into `video.mdx`.

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
