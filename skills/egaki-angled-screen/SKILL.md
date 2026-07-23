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

One-shot workflow: put a flat image or video into an egaki project, wrap it in
`<AngledScreen>`, preview with Vite, capture with `window.egakiSDK.screenshot`
(or `.export` for video).

## Before anything

1. **Load the playwriter skill** and run `playwriter skill` (full output, never truncate).
2. If egaki is not installed or you need API details, fetch the README in full:

```bash
curl -s https://raw.githubusercontent.com/remorses/egaki/main/README.md
```

Never pipe docs through `head`/`tail`. Read the full output.

Canonical component docs live under `## <AngledScreen>` in that README.

## Work in `./tmp` (never pollute the user repo)

Always create a **throwaway project under `./tmp/`** so outputs and deps stay
out of the user's git diff.

```bash
# from the egaki monorepo root
mkdir -p tmp/angled-exports

# copy sources only (do NOT copy node_modules — monorepo symlinks break)
rsync -a --exclude node_modules --exclude dist --exclude .git \
  example-angled-screen/ tmp/angled-screen-job/

# reuse the example's resolved deps via symlink (workspace packages stay valid)
ln -sfn "$(pwd)/example-angled-screen/node_modules" tmp/angled-screen-job/node_modules

cd tmp/angled-screen-job
# drop inputs into public/inputs/, simplify video.mdx to one section, then:
pnpm dev
# note the Local URL — port may not be 5173 if others are busy
```

Outside the monorepo: scaffold a tiny egaki project per the README **into**
`tmp/angled-screen-job`, run `pnpm install` there, then `pnpm dev`.

Rules:

- **Never** edit tracked example projects (`example-angled-screen/`, etc.) for one-off jobs
- **Never** commit `tmp/` assets, `node_modules`, or exports
- Put screenshots under **`tmp/angled-exports/`** (workspace-relative, gitignored)
- If `tmp` / `tmp/` is missing from `.gitignore`, add `tmp` once — do not append duplicates
- Do **not** `cp -R` including `node_modules` in a pnpm monorepo (broken symlinks)
- Do **not** `pnpm install` inside the copied job while it still points at `workspace:^` unless you know what you are doing — symlink `node_modules` instead

## Rules

- **Only flat inputs.** Do not angle photos that are already shot at an angle
  (those are style references, not sources).
- **Match stage background to the content.** White/light UI →
  `backgroundColor="#ffffff"`. Dark UI → near-black. Never leave a white page
  on a black stage.
- **Capture with `window.egakiSDK.screenshot`**, not a browser viewport
  screenshot. That path runs the WebGL shader + export compositor correctly.
- **Read the output image** (vision / Read tool) before sending it to the user.
- Use **plain Chrome** via playwriter. Do not invent Chromium launch flags.

## MDX template

`video.mdx`:

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

Light page variant: set `backgroundColor="#ffffff"`, lower `fog` / `grainIntensity`.

Video input: swap the `<img>` for:

```mdx
<Video
  src="/inputs/clip.mp4"
  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
/>
```

and give the section a real duration (e.g. `duration=5s`).

One section per asset. `duration=1s` is enough for stills (mid-frame = frame 15 at 30fps).

## Prop starters

| Look | Key props |
|---|---|
| Classic left-recede | `rotateX={10}` `rotateY={-22}` `translateZ={100–150}` |
| Mirrored right-recede | `rotateY={20–24}` (positive) |
| Close / dramatic | lower `perspective` (650–800), higher `translateZ` |
| Softer DOF | lower `aperture` / `maxBlur`, set explicit `focus` (0–1 fraction of perspective) |
| Film look | `chromaticAberration={0.5–0.7}` `grainIntensity={0.03–0.2}` |

All props are live in tweakpane. After dialing values, **bake them into the MDX/component props**.

## Pipeline

### 1. Drop the asset

```bash
mkdir -p public/inputs
# local file
cp /path/to/shot.png public/inputs/shot.png
# Discord CDN (always single-quote the full URL)
curl -sL -o public/inputs/shot.png 'https://cdn.discordapp.com/attachments/...'
file public/inputs/shot.png   # must say PNG/JPEG image data, not ASCII text
```

### 2. Start the player

```bash
pnpm dev
# note the Local URL, e.g. http://localhost:5174/
```

### 3. Open in playwriter

```bash
playwriter session new
# if multiple browsers are listed, re-run with --browser <key>
# use the session id printed by session new (examples below use -s 1)
# raise playwriter timeout — default 10s is too low for goto + first paint
playwriter -s 1 --timeout 120000 -e 'await page.goto("http://localhost:5177/", { waitUntil: "domcontentloaded", timeout: 60000 })'
playwriter -s 1 --timeout 120000 -e 'await page.waitForFunction(() => window.egakiSDK && typeof window.egakiSDK.getInfo === "function", { timeout: 90000 })'
playwriter -s 1 -e 'console.log(JSON.stringify(await page.evaluate(() => window.egakiSDK.getInfo()), null, 2))'
```

Replace the port with whatever `pnpm dev` printed. Wait ~1s after load so the
shader paints before the first capture.

### 4. Screenshot (1x)

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const fs = require('node:fs')
const dataUrl = await page.evaluate(async () => {
  return await window.egakiSDK.screenshot({ frame: 15 })
})
const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
fs.writeFileSync('tmp/angled-exports/angled.png', buf)
console.log('wrote', buf.length)
EOF
)"
```

Run playwriter from the **workspace root** so relative `tmp/` paths resolve.
Or use an absolute path under the workspace.

`frame` is composition-global. Mid-frame of section `i` =

```text
startFrame(i) + floor(durationInFrames(i) / 2)
```

Use `getInfo().sections` for start frames.

### 5. Higher definition (2x)

Pass `scale: 2` (or set frontmatter `scale: 2`). A 1920×1080 composition becomes **3840×2160**.

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const fs = require('node:fs')
const dataUrl = await page.evaluate(async () => {
  return await window.egakiSDK.screenshot({ frame: 15, scale: 2 })
})
const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
fs.writeFileSync('tmp/angled-exports/angled-2x.png', buf)
const w = buf.readUInt32BE(16)
const h = buf.readUInt32BE(20)
console.log('png', w, 'x', h, 'bytes', buf.length)
EOF
)"
```

Always pass `--timeout 120000` (or higher) on screenshot calls — 2x renders are slow.

### 6. Export video (optional)

`export` returns a data URL (same as screenshot). Save it from the playwriter sandbox:

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const fs = require('node:fs')
const dataUrl = await page.evaluate(async () => {
  return await window.egakiSDK.export({ frameRange: [0, 149], scale: 1 })
})
const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
fs.writeFileSync('tmp/angled-exports/angled.mp4', buf)
console.log('wrote', buf.length)
EOF
)"
```

Use `scale: 1` for video unless you need a heavy render. `path` only triggers a browser download; always write the data URL to disk for agents. Pass `--timeout 600000` for multi-second clips.

### 7. Validate and deliver

- Confirm PNG dimensions and that the file is real image data
- **Read the image** before uploading / showing the user
- Upload with `kimaki upload-to-discord` when in Discord

## Multi-section batch

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const fs = require('node:fs')
const outDir = 'tmp/angled-exports'
fs.mkdirSync(outDir, { recursive: true })
const info = await page.evaluate(() => window.egakiSDK.getInfo())
for (const s of info.sections) {
  const frame = s.startFrame + Math.floor(s.durationInFrames / 2)
  const name = (s.heading || `section-${s.index}`).toLowerCase().replace(/\s+/g, '-')
  const dataUrl = await page.evaluate(async (f) => {
    return await window.egakiSDK.screenshot({ frame: f, scale: 2 })
  }, frame)
  const buf = Buffer.from(await (await fetch(dataUrl)).arrayBuffer())
  const path = `${outDir}/${name}-angled.png`
  fs.writeFileSync(path, buf)
  console.log('wrote', path, buf.length)
}
EOF
)"
```

## After code edits

Reload the player page so the composition and shader re-init:

```bash
playwriter -s 1 -e 'await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction(() => window.egakiSDK && window.egakiSDK.getInfo()?.sectionCount > 0, { timeout: 60000 })'
```

## QA checklist

- Near edge sharp, far edge soft (hex bokeh, not muddy gaussian mush)
- Purple/cyan fringing only in the blur (`chromaticAberration`)
- Stage color matches the page (no black bars around a white UI)
- Output came from `egakiSDK.screenshot`, not a raw page screenshot
- For print/social hero: used `scale: 2` (or higher)
