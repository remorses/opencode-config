# Resource-aware fade-in

`@starting-style` and CSS keyframes trigger on DOM insertion, not on resource readiness. When an element depends on an external resource (custom font, video, WebGL canvas), it should stay invisible until the resource loads, then fade in. This prevents jarring flashes where unstyled text reflows on font swap or a canvas pops in mid-render.

The pattern: start at `opacity: 0` via inline style, listen for the resource event, flip to `opacity: 1` with a CSS transition. Always add a safety timeout (2-3s) so content appears even if the event never fires.

## Font-dependent text

Use `document.fonts.ready` to wait for custom fonts before revealing text. The promise resolves when all fonts referenced in the page are loaded.

```tsx
const [ready, setReady] = useState(false)

useEffect(() => {
  const timeout = setTimeout(() => setReady(true), 3000)
  document.fonts.ready.then(() => setReady(true))
  return () => clearTimeout(timeout)
}, [])

<div style={{
  opacity: ready ? 1 : 0,
  transition: 'opacity 0.3s cubic-bezier(0.23, 1, 0.32, 1)',
}}>
  <h1 style={{ fontFamily: "'CustomSerif', serif" }}>Title</h1>
</div>
```

## Video / Canvas / WebGL

For video elements, check `readyState >= 3` (HAVE_FUTURE_DATA) immediately in case the video was cached or preloaded and `canplay` already fired before the listener was attached. Otherwise wait for the `canplay` event.

```tsx
const [ready, setReady] = useState(false)

useEffect(() => {
  const timeout = setTimeout(() => setReady(true), 3000)
  if (video.readyState >= 3) {
    setReady(true)
  } else {
    video.addEventListener('canplay', () => setReady(true), { once: true })
  }
  return () => clearTimeout(timeout)
}, [])

<div style={{
  opacity: ready ? 1 : 0,
  transition: 'opacity 0.4s cubic-bezier(0.23, 1, 0.32, 1)',
}}>
  <canvas />
</div>
```

For Three.js, use the `onCreated` callback or fire a custom `onReady` prop from the engine after the first frame renders.

## Rules

- Use ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`) since the element is entering
- Keep duration at 300-400ms; this is a one-time first-visit animation
- Check `readyState` immediately for cached/preloaded resources where the event already fired before the listener was attached
- If the element has sibling overlays (gradients, masks), fade them in together with the same ready state to avoid white flash artifacts
- Only animate `opacity`; it is GPU-composited and causes no layout or paint
