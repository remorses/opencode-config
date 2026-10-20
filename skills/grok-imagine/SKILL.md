---
$schema: https://gist.githubusercontent.com/remorses/9f3737a6f516c01f4bdb612045c64072/raw/agent-skill.schema.json
name: grok-imagine
description: "Generate images and videos on grok.com/imagine with the signed-in Grok session (text to video, image to video, 480p drafts). Use when the user wants Grok Imagine, a landscape image, a Grok video, or to replay a recorded Imagine prompt. Prefer the in-page network API, not UI clicks."
---

# Grok Imagine

Preconditions: the user is signed in on [grok.com](https://grok.com/imagine).
Playwriter drives that tab. Do not copy cookies or tokens.

Recorded flow: type a prompt, set aspect **Ampio** (wide / `16:9`), click
**Invia**. The only useful recorded network call is quota. Image generate
is not REST. It uses `wss://grok.com/ws/imagine/listen`. Both run inside
`state.page.evaluate` so the page cookies apply.

Drop: empty paragraph click, analytics (`/_data/`, Stripe, Appsflyer),
and the `.scheme-light` CSS click.

## Parameters

- `prompt` — recorded demo: `a nice landscape`
- `aspectRatio` — `16:9` for Ampio. Also `1:1`, `9:16`

## 1. Open Imagine

```bash
playwriter -s 1 -e 'state.page = context.pages().findLast((p) => p.url().startsWith("https://grok.com/")) ?? await context.newPage(); await state.page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded" })'
```

## 2. Check quota with fetch

```bash
playwriter -s 1 -e 'const q = await state.page.evaluate(async () => { const r = await fetch("/rest/media/imagine/quota_info", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: "{}" }); return { status: r.status, body: await r.json() } }); console.log(q)'
```

Expect `status: 200` and `image.available: true`. If 401/403, ask the user
to sign in.

## 3. Generate with the Imagine websocket

Do not fill the textbox or click **Invia**. `POST /rest/media/post/create`
only creates an empty post. Generate from `evaluate`:

```bash
playwriter -s 1 -e 'const { join } = require("node:path"); const { homedir } = require("node:os"); const { generateImagineImage } = await import(join(homedir(), ".agents/skills/grok-imagine/utils.js")); console.log(await generateImagineImage({ page: state.page, prompt: "a nice landscape", aspectRatio: "16:9", count: 1 }))'
```

Expect `images[].url` on `https://imagine-public.x.ai/imagine-public/images/<id>.jpg`.

For a project-local copy of this skill:

```bash
playwriter -s 1 -e 'const { generateImagineImage } = await import("./.agents/skills/grok-imagine/utils.js"); console.log(await generateImagineImage({ page: state.page, prompt: "a nice landscape", aspectRatio: "16:9" }))'
```

## Video

Same Imagine page, **Video** mode, driven by the SDK in `utils.js`
(`import(homedir + "/.config/opencode/skills/grok-imagine/utils.js")`).
Three steps, so many generations can be in flight:

| Function | What it does |
| --- | --- |
| `startImagineVideo({ page, prompt, imagePaths?, aspectRatio?, duration?, resolution? })` | Uploads images, starts the generation, returns `{ id, page }` at once |
| `waitImagineVideo({ page, id, onProgress?, timeoutMs? })` | Polls until ready, returns `{ videoUrl, videoId, width, height }` |
| `downloadImagineVideo({ page, videoUrl, outPath })` | Saves the mp4 (needs page cookies; plain curl gets 403) |
| `getImagineVideoStatus({ page, id })` | Non blocking `{ progress, done, video?, error? }` |
| `getGrokPages({ context, count })` | Opens N static grok.com tabs for parallel work |
| `generateImagineVideo({ ..., outPath })` | start + wait + download for one clip |

Inputs: no image = text to video; 1 image = image to video (it is the first
frame); 2+ images = reference to video. `resolution` `"480p"` (draft, 20-40s,
default) or `"720p"`; `duration` 6, 10 or 15; `aspectRatio` `16:9`, `9:16`,
`1:1`, `2:3`, `3:2`.

```bash
playwriter -s 1 --timeout 600000 -e '
const sdk = await import(require("node:os").homedir() + "/.config/opencode/skills/grok-imagine/utils.js");
const pages = await sdk.getGrokPages({ context, count: 3 });
const prompts = ["slow push in on a desk", "slider move left to right", "macro of a cable"];
const jobs = await Promise.all(prompts.map((prompt, i) => sdk.startImagineVideo({ page: pages[i % pages.length], prompt, imagePaths: ["/abs/frame.png"] })));
for (const [i, job] of jobs.entries()) { const done = await sdk.waitImagineVideo(job); await sdk.downloadImagineVideo({ page: job.page, videoUrl: done.videoUrl, outPath: `/abs/out-${i}.mp4` }) }
'
```

### Run in parallel

- **Use several tabs** (`getGrokPages({ count: 3 })`) and spread jobs across them; `start` returns in a second, so fire all jobs, then wait.
- **Max ~5 in flight.** At 8 concurrent, Grok returned empty streams for most jobs. 5 jobs over 3 tabs finished in 25 s total.
- Tabs must be `https://grok.com/robots.txt` (the SDK opens them). On `/imagine` the app soft-navigates mid-request and `page.evaluate` dies with "Execution context was destroyed". Do not reuse a tab another script navigates.
- After editing `utils.js`, import it with `?v=${Date.now()}`: playwriter caches modules per session.
- Skip jobs whose output exists, append one line per clip to a manifest (prompt, source frame, size), so a crash resumes.

### Network (for debugging or porting)

`POST /http/upload-file-v2/direct` (multipart field `file`, returns
`fileMetadata.fileMetadataId`), then `POST /rest/app-chat/conversations/new`
with `modelName: "imagine-video-gen"`, `message: "<prompt> --mode=custom"`,
`kind: "CONVERSATION_KIND_IMAGINE"` and `mediaGenInput` =
`{ textToVideo | imageToVideo | referenceToVideo: { prompt, aspectRatio, duration, resolutionName, inputAssets?, mode? } }`.
It streams NDJSON; `result.response.streamingVideoGenerationResponse.progress`
goes 0-100 and the last event has `videoUrl`
(`users/<uid>/generated/<id>/generated_video.mp4`, fetch from
`https://assets.grok.com/`). `moderated: true` means refused.

### Prompt lessons

- **Start from a good first frame.** Image-to-video beats text-to-video for control. Make the frame with `gpt-image-2` (via `egaki image -m gpt-image-2 --aspect-ratio 3:2`, then crop to 16:9; it only supports 1:1, 3:2, 2:3). It keeps phone UI legible; nano-banana frames gave mushier clips.
- **Describe only the motion** for image-to-video. The image already holds the look.
- **Camera words that work:** "locked-off tripod, rock steady", "extremely slow smooth push-in", "slow slider move left to right", "slow pull-back and slight rise", "slow subtle orbit". Add "no morphing". Plain "dolly in" zooms too hard.
- **Avoid "haze", "fog", "glow":** the frame washes out. Say "no fog, no haze" when the source has bokeh lights.
- **Phone screens:** feeds scroll, chats fill, maps route plausibly, but small text morphs between frames. Keep screens large and simple, or replace them with real recordings in post.
- **Hands:** say "no hands" or "no hands in frame" for UI shots, otherwise fingers appear. A "translucent grey tap dot" gives a believable touch indicator.
- **People:** "speaks naturally to camera, small head movements, blinks, static camera" gives usable talking heads. Lip sync does not match any script; plan cutaways.
- **Several screens:** name what each does ("left swipes a video, middle scrolls photos, right gets chat replies").
- **Drafts first:** use 480p to find the prompt, rerun only keepers at 720p. 10 s clips drift more than 6 s ones.
- **Audio:** the generated audio track is not wanted for b-roll; drop it in the edit.
