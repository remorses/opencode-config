# Porting Jitter animations to Remotion / egaki

Guide for recreating a Jitter animation in Remotion using egaki's MDX video
framework. Covers scene extraction, concept mapping, exact easing curves, and
frame-by-frame comparison workflow.

Working examples: `modular-example/` (bento grid), `mirror-example/` (social
media showcase with mirrored galleries), `testimonial-example/` (frosted glass
card with masked text reveal, heart fill, customizable via MDX props),
`acme-example/` (website promo with legacy easing names, em-box word masks,
SE-anchored mask collapse) in the egaki repo.

## Extracting the scene graph

The `jitterUtils` traversal functions require loading a JS bundle. A more reliable
approach is reading `window.app` directly on the editor page.

**Extract `fromValue` and all item properties.** The minimal extraction code only
captures `toValue`, but many operations need `fromValue` too:
- `resize` ops have `fromValue: { width: 0, height: 0 }` (grow from nothing)
- `scale` ops can have `fromValue: 2` (start at 2x, not at the layer's base scale)
- `move` ops can have `fromValue: { moveX: 100 }` (start offset, animate to 0)

```javascript
const sceneData = await page.evaluate(() => {
  const conf = window.app.getState().observableImmutableConf.getSnapshot()
  const root = conf.roots[0]

  const artboard = {
    id: root.id, name: root.item.name,
    width: root.item.width, height: root.item.height,
    duration: root.item.duration, fillColor: root.item.fillColor,
  }

  const layersTree = root.children.find(c => c.item.type === 'layersTree')
  const opsTree = root.children.find(c => c.item.type === 'operationsTree')

  function flattenLayers(node) {
    const i = node.item
    return {
      id: node.id, type: i.type, name: i.name,
      x: i.x, y: i.y, width: i.width, height: i.height,
      angle: i.angle, scale: i.scale, opacity: i.opacity,
      fillColor: i.fillColor, cornerRadius: i.cornerRadius,
      clipsContent: i.clipsContent,
      text: i.text, font: i.font, fontSize: i.fontSize,
      url: i.url,
      children: (node.children || []).map(flattenLayers),
    }
  }

  function flattenOps(node) {
    const i = node.item
    return {
      id: node.id, type: i.type,
      startTime: i.startTime, endTime: i.endTime,
      targetId: i.targetId,
      fromValue: i.fromValue, toValue: i.toValue,
      easing: i.easing, anchor: i.anchor,
      // textIn-specific fields
      effect: i.effect, split: i.split,
      nodeDuration: i.nodeDuration, nodeEasing: i.nodeEasing,
      offset: i.offset, travelDistance: i.travelDistance,
      slideDirection: i.slideDirection, order: i.order,
      children: (node.children || []).map(flattenOps),
    }
  }

  return {
    artboard,
    layers: flattenLayers(layersTree),
    operations: flattenOps(opsTree),
  }
})
```

## Layer properties to watch for

The `angle` property on layer groups is critical and easy to miss. A group with
`angle: -180` is rotated 180 degrees, which mirrors its content both horizontally
and vertically. This creates the "mirror" effect in templates like "Mirror: Social
Media Showcase."

Always check these properties on every layer group:
- **`angle`** (degrees) — apply as `transform: rotate(Xdeg)` in CSS
- **`scale`** — the layer's base scale (separate from animated scale operations)
- **`opacity`** — base opacity (0-100, divide by 100 for CSS)
- **`clipsContent`** — if true, add `overflow: 'hidden'`

```javascript
// After extracting layers, check for non-default values
const groups = flattenAll(layersTree).filter(n => n.type === 'layerGrp')
groups.forEach(g => {
  if (g.angle !== 0) console.log(`${g.name} has angle=${g.angle}`)
  if (g.scale !== 1) console.log(`${g.name} has scale=${g.scale}`)
})
```

## Jitter to Remotion concept mapping

| Jitter concept | Remotion equivalent |
|---|---|
| artboard (width, height, duration) | `<AbsoluteFill>` sized to artboard, total frames = duration x fps / 1000 |
| layerGrp | `<div style={{ position: 'absolute' }}>` with `rotate()` if `angle !== 0` |
| maskGrp | `<div>` with `overflow: 'hidden'` and `borderRadius` |
| rect | `<div>` with `backgroundColor`, `borderRadius` |
| svg, image | `<img src={url}>` |
| text | `<div>` with font styles from `font.name`, `font.weight` |
| position (x, y) | `left: x, top: y` (relative to parent group) |
| clipsContent | `overflow: 'hidden'` |
| move ops | change CSS `left`/`top` position (NOT `transform: translate`) |
| scale ops | `transform: scale()` with `transform-origin: center center` |
| opacity ops | CSS `opacity` property |
| show/hide ops | conditional rendering (return null when hidden) |
| resize ops | animate `width`/`height` from 0 to natural size |
| textIn ops | per-letter staggered animation (see textIn section) |

### Composition size

egaki's Remotion composition is hardcoded to **1920x1080 at 30fps**. If the Jitter
artboard has different dimensions (e.g. 1080x1350), scale the entire artboard to fit
and center it inside the composition:

```tsx
const COMP_W = 1920, COMP_H = 1080
const scale = Math.min(COMP_W / artboard.width, COMP_H / artboard.height)
const offsetX = (COMP_W - artboard.width * scale) / 2
const offsetY = (COMP_H - artboard.height * scale) / 2
```

## Move vs scale transform separation

In Jitter, `move` operations change the element's **position** (x, y), then `scale`
is applied from the element's center at the **new** position. This is different from
CSS `transform: translate(X) scale(Y)` which composes the transforms together.

Apply move offsets to CSS `left`/`top`, and only scale in `transform`:

```tsx
// CORRECT: move in position, scale in transform
<div style={{
  position: 'absolute',
  left: groupX + moveOffsetX,
  top: groupY + moveOffsetY,
  transform: `rotate(${angle}deg) scale(${groupScale})`,
  transformOrigin: 'center center',
}}>

// WRONG: both in transform (different visual result)
<div style={{
  position: 'absolute',
  left: groupX,
  top: groupY,
  transform: `translate(${moveOffsetX}px, ${moveOffsetY}px) scale(${groupScale})`,
  transformOrigin: 'center center',
}}>
```

The difference is subtle but causes major layout issues. With the wrong approach,
scaled elements end up in completely different positions because `translate` and
`scale` interact with `transform-origin` differently than position + scale.

## Custom bezier easing format

Jitter's `custom:path:v1` easings use `controlPoints` that map to CSS cubic-bezier:

```
controlPoints: [
  { upper: 0.5375, x: 0, y: 0 },  // first control point
  { lower: 0.65,   x: 1, y: 1 },  // second control point
]
```

When `upper` and `lower` are **numbers**, the bezier is:
`cubic-bezier(upper, 0, lower, 1)`

When `upper` is an **object** `{ x, y }`, the bezier is:
`cubic-bezier(upper.x, upper.y, lower, 1)`

```tsx
function jitterEasingToBezier(easing) {
  if (easing.name !== 'custom:path:v1') {
    // Named easing: use the egaki preset for that name (see mapping table)
    // e.g. impulseOvershoot(easing.config?.intensity ?? 50)
    return lookupEgakiPreset(easing.name)(easing.config?.intensity ?? 50)
  }
  const [p1, p2] = easing.config.controlPoints
  const x1 = typeof p1.upper === 'object' ? p1.upper.x : p1.upper
  const y1 = typeof p1.upper === 'object' ? p1.upper.y : 0
  const x2 = p2.lower
  const y2 = 1
  return Easing.bezier(x1, y1, x2, y2)
}
```

## Easing mapping

All Jitter easings are available as egaki presets. Import from `egaki/video`
(which re-exports from `egaki/src/vite/mdx-video.tsx`). Every easing works
directly with Remotion's `interpolate()`.

```tsx
import { EASE, smoothEasing, bounceEasing, overshootEasing } from 'egaki/video'
import { interpolate } from 'remotion'

// Default presets (intensity 50)
interpolate(frame, [0, 60], [0, 1], { easing: EASE.smooth })
interpolate(frame, [0, 60], [0, 1], { easing: EASE.bounce })
interpolate(frame, [0, 60], [0, 1], { easing: EASE.overshootElastic })

// Custom intensity 0-100
interpolate(frame, [0, 60], [0, 1], { easing: smoothEasing(75) })
interpolate(frame, [0, 60], [0, 1], { easing: bounceEasing(100) })
```

### Non-standard intensities (continuous presets)

Jitter's intensity dial is **continuous**, and real scenes use values like 96
or 71, not just multiples of 25. egaki ports Jitter's actual curve engine, so
the 14 spring/bounce/overshoot preset functions accept ANY intensity 0-100
(configs interpolated in control-point space, exactly like Jitter):

```tsx
import { impulseOvershoot, overshoot, naturalThrow } from 'egaki/video'

// exact Jitter curve at intensity 96 — no snapping, no approximation
const cardPulseEasing = impulseOvershoot(96)
const heartEasing = impulseOvershoot(71)
```

Always use the continuous preset functions when the scene's `easing.config.intensity`
is not a multiple of 25. Never approximate by rounding to the nearest preset level.
The engine builders (`pathPreset`, `springPreset`, `bouncePreset`, `cubicBezier`,
`polybezier`) are also exported from `egaki/video` for custom curves.

`smooth:standard:v1` at intensity 50 is exactly `Easing.bezier(0.5, 0, 0, 1)`.

### Jitter name to egaki name mapping

| Jitter easing | egaki `EASE.*` preset | `*Easing(intensity)` function |
|---|---|---|
| `smooth:standard:v1` | `EASE.smooth` | `smoothEasing(i)` |
| `natural:standard:v1` | `EASE.natural` | `naturalEasing(i)` |
| `slowdown:standard:v1` | `EASE.decelerate` | `decelerateEasing(i)` |
| `accelerate:standard:v1` | `EASE.accelerate` | `accelerateEasing(i)` |
| `elastic:standard:v1` | `EASE.elasticSnap` | `elasticSnapEasing(i)` |
| `bounce:standard:v1` | `EASE.bounce` | `bounceEasing(i)` |
| `bounce:anticipate:v1` | `EASE.bounceAnticipate` | `bounceAnticipateEasing(i)` |
| `bounce:throw:v1` | `EASE.bounceThrow` | `bounceThrowEasing(i)` |
| `overshoot:standard:v1` | `EASE.overshoot` | `overshootEasing(i)` |
| `overshoot:elastic:v1` | `EASE.overshootElastic` | `overshootElasticEasing(i)` |
| `overshoot:bouncy:v1` | `EASE.overshootBouncy` | `overshootBouncyEasing(i)` |
| `slowdown:overshoot:v1` | `EASE.decelerateOvershoot` | `decelerateOvershootEasing(i)` |
| `slowdown:elasticOvershoot:v1` | `EASE.decelerateElastic` | `decelerateElasticEasing(i)` |
| `natural:throw:v1` | `EASE.naturalThrow` | `naturalThrowEasing(i)` |
| `accelerate:impulse:v1` | `EASE.accelerateImpulse` | `accelerateImpulseEasing(i)` |
| `accelerate:elastic:v1` | `EASE.accelerateElastic` | `accelerateElasticEasing(i)` |
| `impulse:standard:v1` | `EASE.impulseSlow` | `impulseSlowEasing(i)` |
| `impulseAndOvershoot:standard:v1` | `EASE.impulseOvershoot` | `impulseOvershootEasing(i)` |

For automated conversion scripts, build a `Record<JitterEasingName, EasingPreset>`
from this table using the continuous preset functions exported by `egaki/video`.

### Legacy easing names (unversioned)

Older Jitter projects store **unversioned** easing names on their ops:
`easing: { name: 'natural' }`, `slowDown`, `accelerate`, `linear` — no
`:standard:v1` suffix and no `config.intensity`. The versioned table above
does NOT apply to these. The actual runtime curves were derived by sampling
`/api/renderer/` frames and fitting cubic beziers (fit error < 0.001,
acme-example session):

| legacy name | measured curve | Remotion |
|---|---|---|
| `natural` | `cubic-bezier(0.25, 0.1, 0.25, 1)` — the CSS `ease` | `Easing.bezier(0.25, 0.1, 0.25, 1)` |
| `slowDown` | cubic ease-out `1-(1-x)^3` | `Easing.out(Easing.cubic)` |
| `accelerate` | cubic ease-in `x^3` | `Easing.in(Easing.cubic)` |
| `linear` | identity | `(t) => t` |

If you assume `natural` = `natural:standard:v1` (`bezier(0.8, 0, 0.2, 1)`)
the motion will be visibly wrong (slow start vs immediate start). When in
doubt, verify against reference frames using the curve-fitting workflow in
the comparison section below.

## Additive animation model

A single Jitter layer can have **multiple sequential move operations** that
accumulate. For example, a card moves up in Phase 1 (500-2700ms), then the same
card moves left in Phase 2 (3200-5550ms). At any frame, sum all interpolated
offsets for that layer:

```tsx
function computeOffset(layerId: string, frame: number, fps: number) {
  let x = 0, y = 0
  for (const anim of animations.filter(a => a.targetId === layerId)) {
    const startFrame = (anim.startMs / 1000) * fps
    const endFrame = (anim.endMs / 1000) * fps
    const progress = interpolate(frame, [startFrame, endFrame], [0, 1], {
      easing: Easing.bezier(0.5, 0, 0, 1),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
    if (anim.toValue.moveX) x += anim.toValue.moveX * progress
    if (anim.toValue.moveY) y += anim.toValue.moveY * progress
  }
  return { x, y }
}
```

Build a `Map<string, MoveAnim[]>` lookup at module scope so the per-frame
computation avoids repeated `.filter()` calls.

## Overlapping scale operations

Two scale operations can target the same element with **overlapping time ranges**.
The second operation "takes over" from the current animated value at its start time.
You need to compute a **handoff value** by evaluating the first operation at the
second operation's start time.

```tsx
function computeGroupScale(frame: number, fps: number) {
  const { phase1, phase2 } = ANIM
  const timeMs = (frame / fps) * 1000

  if (timeMs < phase1.startMs) return phase1.scaleFrom

  if (timeMs < phase2.startMs) {
    // Phase 1 active
    return interpClamp(frame, phase1.startMs, phase1.endMs,
      phase1.scaleFrom, phase1.scaleTo, fps, phase1Easing)
  }

  // Phase 2: compute handoff from Phase 1 at Phase 2's start time
  const handoffFrame = (phase2.startMs / 1000) * fps
  const handoffScale = interpClamp(handoffFrame, phase1.startMs, phase1.endMs,
    phase1.scaleFrom, phase1.scaleTo, fps, phase1Easing)

  return interpClamp(frame, phase2.startMs, phase2.endMs,
    handoffScale, phase2.scaleTo, fps, phase2Easing)
}
```

When `fromValue` is undefined in a scale operation, it means "start from wherever
the current animated value is." When `fromValue` is a number, it means "set the
scale to this value at startTime."

## Resize operations (mask reveal)

The `resize` operation type animates a mask rect from `fromValue: { width: 0,
height: 0 }` to the element's natural dimensions. The `toValue` is undefined
because the target is the element's own width/height properties.

In Remotion, implement as a div with `overflow: 'hidden'` whose width/height
animate from 0 to the target size. Center the growing rect by offsetting position:

```tsx
const maskW = card.maskWidth * resizeProgress
const maskH = card.maskHeight * resizeProgress
const offsetX = (card.maskWidth - maskW) / 2
const offsetY = (card.maskHeight - maskH) / 2

<div style={{
  position: 'absolute',
  left: card.x + offsetX,
  top: card.y + offsetY,
  width: maskW,
  height: maskH,
  overflow: 'hidden',
}}>
  <img src={imageSrc} style={{
    position: 'absolute',
    left: card.imgX - offsetX,
    top: card.imgY - offsetY,
    width: card.imgWidth,
    height: card.imgHeight,
  }} />
</div>
```

### Resize anchors other than `center`

The `anchor` field can pin a corner instead: `'se'` keeps the bottom-right
corner fixed while width/height animate (used for collapse-out effects where
the mask shrinks toward a corner). Derive `left`/`top` from the pinned corner:

```tsx
// SE corner pinned at (cornerX, cornerY) — at rest this is
// (centerX + restW / 2, centerY + restH / 2)
const left = collapsing ? cornerX - maskW : centerX - maskW / 2
const top = collapsing ? cornerY - maskH : centerY - maskH / 2
```

While the rect is still centered the two formulas agree (`corner = center +
size/2`), so the corner-derived form is safe in both phases. A resize with
`toValue: { width: 0, height: 0 }` collapses the mask to nothing; children
keep their artboard coordinates relative to the moving mask origin
(`childLeft = childArtboardX - maskLeft`).

## textIn operations (per-letter animation)

The `textIn` type animates text character-by-character. Key properties:

| Field | Description |
|---|---|
| `split` | `'letters'` or `'words'` |
| `slideDirection` | `'up'`, `'down'`, `'left'`, `'right'` |
| `travelDistance` | PERCENT of the unit's em box each letter/word travels (100 = fully hidden) |
| `nodeDuration` | duration per letter in ms (e.g. 198) |
| `offset` | stagger delay between letters in ms (e.g. 60) |
| `nodeEasing` | per-letter easing (can differ from the overall easing) |
| `order` | `'forward'` or `'reverse'` |
| `effect` | `'appear'`, `'slideAndMask'` |

**`travelDistance` is a percentage, not pixels.** Measured from renderer
frames (acme-example): `travelDistance: 100` moved each word by exactly the
word's full em box (ascent + descent ≈ 1.3em, e.g. 208px at fontSize 160).
Treating it as 100px makes the words never fully leave their masks.

Each letter/word starts at `startMs + (index * offset)` and lasts `nodeDuration` ms.
It slides from `travelDistance` in `slideDirection` to 0, while fading from 0 to 1:

```tsx
function AnimatedText({ text, startMs, letterDurationMs, offsetMs, travelY, easing, frame, fps }) {
  return (
    <span style={{ display: 'inline-flex' }}>
      {text.split('').map((char, i) => {
        const charStartMs = startMs + i * offsetMs
        const charEndMs = charStartMs + letterDurationMs
        const progress = interpClamp(frame, charStartMs, charEndMs, 0, 1, fps, easing)
        return (
          <span key={i} style={{
            display: 'inline-block',
            transform: `translateY(${travelY * (1 - progress)}px)`,
            opacity: progress,
            whiteSpace: char === ' ' ? 'pre' : undefined,
          }}>
            {char}
          </span>
        )
      })}
    </span>
  )
}
```

### textIn with `effect: 'slideAndMask'`

Besides `'appear'`, textIn can have `effect: 'slideAndMask'`: each word slides
up into view through its own clipping mask, with **no opacity fade**. Implement
with a per-word `inline-block` + `overflow: hidden` wrapper and an inner span
translated by its own height:

```tsx
{text.split(' ').map((word, i) => {
  const wordStartMs = startMs + i * offsetMs
  const progress = interpClamp({ frame, startMs: wordStartMs,
    endMs: wordStartMs + nodeDurationMs, from: 0, to: 1, fps, easing })
  return (
    <span key={i}>
      <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top' }}>
        <span style={{ display: 'inline-block', transform: `translateY(${(1 - progress) * 100}%)` }}>
          {word}
        </span>
      </span>
      {i < words.length - 1 ? ' ' : null}
    </span>
  )
})}
```

Keep the literal space **outside** the overflow-hidden wrapper so the browser
can wrap lines naturally at the same points as Jitter.

Two slideAndMask details measured from renderer frames (acme-example):

- **The mask window is the word's full em box**, not its line box. Words clip
  exactly at `baseline + descent` (≈ 0.31em below baseline for DM Sans) and
  `baseline - ascent` above. With `line-height: 1` glyphs overflow the line
  box by `(ascent + descent - 1) / 2` em on each side, so the overflow-hidden
  window must extend beyond the line box (or use `line-height: 1.3` so the
  box IS the em box). A window cropped to the glyph bounds clips mid-flight
  fragments at the wrong rows.
- **Word spacing may collapse.** A source text of `"www. acme. com"` with
  `split: 'words'` rendered the three words ADJACENT (total width matched
  the no-space layout). Don't trust the source string's spaces — measure the
  rendered text width in a reference frame first (threshold the white text
  with `magick -fuzz 4% -fill black +opaque white -format "%@" info:` over a
  flat background region).

### textOut (slideAndMaskOut)

`textOut` ops mirror textIn and are **additive** with it: the same text node
can have both, so compute `translateY = inOffset + outOffset`. Same fields
(`split`, `offset`, `nodeDuration`, `nodeEasing`, `travelDistance`,
`slideDirection`). With `effect: 'slideAndMaskOut'` and `slideDirection:
'down'` each word slides down out of the same em-box window, staggered by
`offset` ms in `order`. No opacity fade.

## Value mapping gotchas

- **`lineHeight` is a percent of fontSize.** A text layer with `fontSize: 32`
  and `lineHeight: 108.79` renders at `32 * 1.0879 = 34.8px` line height.
- **`letterSpacing` is a percent of fontSize too** (Figma-style). A text layer
  with `fontSize: 160` and `letterSpacing: -4` renders at `-6.4px` tracking,
  not `-4px`. Verified by measuring rendered text width (1175px vs 1198px).
- **ImageMagick `%[mean]` includes the alpha channel.** SDK screenshots carry
  an opaque alpha plane; `(3*rgb + 65535) / 4` inflates the mean ~2x vs a
  flattened reference and fakes a brightness mismatch. Strip alpha
  (`-alpha off`) before any pixel statistics.
- **`blurRadius` ≈ 2x the CSS blur sigma.** Jitter `blurRadius: 109` matches
  CSS `filter: blur(54.5px)`.
- **Tailwind preflight clamps images.** The egaki player ships Tailwind's
  preflight (`img { max-width: 100% }`), which silently shrinks absolutely
  positioned images sized larger than their parent. Always set
  `maxWidth: 'none'` on every `<img>`.
- **Scale ops where content must stay put.** When Jitter scales a mask rect
  (e.g. a card pulsing to 1.1x) but the card's text stays in place, do NOT use
  `transform: scale` (it would scale the content too if applied to a shared
  parent, or shift the mask if applied separately). Animate the rect's
  width/height/borderRadius anchored at its center instead, and keep content
  positioned in artboard coordinates.

## Image asset optimization

Jitter's CloudFront CDN serves **original-resolution** images. Some can be 8K
(7680x4320, 8.7MB). These get rendered at thumbnail size (e.g. 50-200px on screen)
through nested CSS transforms, which destroys browser rendering performance.

After downloading assets, **always resize to max ~700px tall**:

```bash
for f in public/images/*; do
  h=$(sips -g pixelHeight "$f" 2>/dev/null | grep pixelHeight | awk '{print $2}')
  if [ "$h" -gt 700 ]; then
    sips --resampleHeight 700 "$f" --out "$f"
  fi
done
```

This typically reduces total image size by 90%+ (e.g. 50MB to 2MB) with no visible
quality loss at the rendered sizes.

## Frame-by-frame comparison

Use Jitter's `/api/renderer/` to render reference frames, then compare against
Remotion's output at matching timestamps to verify accuracy:

```javascript
// Jitter reference frame at 4000ms
const jitterBase64 = await rendererPage.evaluate(async () => {
  return btoa((await window.jitter.renderFrame(4000)).pngString)
})
fs.writeFileSync('/tmp/jitter-4000.png', Buffer.from(jitterBase64, 'base64'))

// Remotion frame at 4000ms (frame 120 at 30fps)
const remotionDataUrl = await egakiPage.evaluate(() =>
  window.egakiSDK.screenshot({ frame: 120 })
)
```

Compare at phase boundaries (start, each transition midpoint, end) to catch
timing or easing mismatches early.

### Choosing the screenshot path

- **Try `allowHtmlInCanvas: true` first** (the default). It takes a real
  screenshot per frame, honors all CSS clipping, and was pixel-accurate for a
  full-frame 16:9 artboard (acme-example). Risk: all-black frames for complex
  scenes with many nested transforms — if that happens, fall back to DOM
  screenshots below.
- **Never trust `allowHtmlInCanvas: false` for masked scenes.** The software
  rasterizer **ignores `overflow: hidden` clipping**: a mask div animated to
  0x0 (or any mask smaller than its children) still paints the children in
  full, producing false mismatches even though the live player is correct.

### DOM screenshots as fallback

For pixel comparison without the SDK, seek the player and screenshot the
player element with Playwright instead:

```javascript
await page.evaluate((f) => window.egakiSDK.seekTo(f), frame)
const el = await page.$('.__remotion-player')
await el.screenshot({ path: `/tmp/dom-${ms}.png` })
```

### Aligning the two screenshots

Two cropping steps are needed before images can be diffed:

- **Jitter renderer PNGs are letterboxed.** With `width=1920&height=1080&
  superSampling=2` the artboard renders at HALF size (960x540) centered in
  the 1920x1080 PNG with transparent padding. Verify the content bbox once
  (`magick ref.png -alpha extract -threshold 50% -format "%@" info:` →
  `960x540+480+270`), then crop and flatten every reference onto the
  artboard fill color:

  ```bash
  magick ref-1400.png -crop 960x540+480+270 +repage \
    -background '#506c53' -alpha remove refn-1400.png
  ```
- **Letterbox bars in the player.** When the artboard aspect ratio differs
  from the 16:9 composition, the scaled artboard is centered with bars on the
  sides. Crop the DOM screenshot to the artboard area (offsets scale with the
  screenshot's device-pixel width) before resizing to match the reference.

```python
from PIL import Image
ref = Image.open('ref.png').convert('RGB').crop(ref_content_bbox)
dom = Image.open('dom.png').convert('RGB')
w, h = dom.size
x0, x1 = round(offset_x / 1920 * w), round((1920 - offset_x) / 1920 * w)
dom = dom.crop((x0, 0, x1, h)).resize(ref.size)
```

### ImageMagick comparison toolkit

Score every key timestamp numerically, then look at WHERE the differences
are. Font antialiasing on glyph edges sets a noise floor around RMSE 0.05;
frames without text should score < 0.01.

```bash
# numeric score per timestamp (strip alpha first, see gotchas)
magick egaki-1400.png -resize 960x540 -alpha off egn-1400.png
magick compare -metric RMSE refn-1400.png egn-1400.png null:

# WHERE is the diff? amplified difference image — glyph outlines = noise
# floor, solid shapes = real geometry/timing errors
magick refn-1400.png egn-1400.png -compose difference -composite \
  -auto-level diff-1400.png

# side-by-side pairs and review grids
magick refn-1400.png egn-1400.png +append pair-1400.png   # horizontal
magick montage pair-*.png -tile 1x6 -geometry +2+2 -label "%f" grid.png
```

Measure geometry per frame with bbox thresholds — this is how you extract
rect sizes and text positions as numbers instead of eyeballing:

```bash
# black rect width at a given row: scan a 6px strip, key out the bg color
magick refn-3400.png -crop 1920x6+0+232 +repage \
  -fuzz 20% -fill white -opaque '#506c53' -negate -format "%@" info:
# → 1116x6+402+0  (width 1116, left edge 402)

# white text bbox over a flat background region
magick refn-1400.png -crop 560x1080+0+0 +repage \
  -fuzz 4% -fill black +opaque white -format "%@" info:
```

### Reverse-engineering an easing from frames

When an easing name is ambiguous (legacy names, unknown intensity), sample
the renderer at 8-12 timestamps, measure the animated value with the strip
technique above, normalize to (x, progress) pairs, and grid-search a cubic
bezier:

```python
pts = [(0.071,0.06),(0.143,0.17),(0.214,0.33),(0.286,0.48),(0.357,0.62),
       (0.429,0.72),(0.5,0.80),(0.571,0.86),(0.643,0.92),(0.714,0.95)]
def bez(p1x,p1y,p2x,p2y,x):
    lo,hi=0.0,1.0
    for _ in range(50):
        t=(lo+hi)/2
        xt=3*t*(1-t)**2*p1x+3*t*t*(1-t)*p2x+t**3
        if xt<x: lo=t
        else: hi=t
    t=(lo+hi)/2
    return 3*t*(1-t)**2*p1y+3*t*t*(1-t)*p2y+t**3
def frange(a,b,s):
    v=a
    while v<b: yield v; v+=s
best=None
for p1x in frange(0,0.9,0.05):
  for p1y in frange(0,0.9,0.05):
    for p2x in frange(0,0.7,0.05):
      for p2y in frange(0.6,1.05,0.05):
        err=sum((bez(p1x,p1y,p2x,p2y,x)-y)**2 for x,y in pts)
        if best is None or err<best[0]: best=(err,p1x,p1y,p2x,p2y)
print(best)  # acme-example resize fit: (0.25, 0.10, 0.25, 1.0) = CSS ease
```

For power curves (text slides), check the exponent directly first:
`log(y2/y1) / log(x2/x1)` ≈ 3 means cubic ease-in (`x^3`); the mirrored
check on `1-y` vs `1-x` detects cubic ease-out.
