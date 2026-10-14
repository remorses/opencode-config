// Arrows between boxes. Boxes are laid out by css (.flow grid), arrows read their
// positions after fonts load, so nobody writes coordinates.
//
//   <script type="module">
//     import { connect } from '/skill/diagram.ts'
//     connect('dev', 'cache', { color: 'accent', label: 'Trees and file contents', sub: 'Object plane' })
//     connect('cache', 'server', { from: 'right', to: 'bottom', color: 'accent', label: 'Misses' })
//   </script>
//
// `from` and `to` are element ids. Sides are picked from the layout: horizontal when the boxes
// do not overlap horizontally, else vertical. Pass `from` / `to` to force a side.
// When two boxes overlap on the cross axis the arrow is straight, through the middle of the overlap.

type Side = 'left' | 'right' | 'top' | 'bottom'
type Point = [number, number]
type Rect = { left: number; top: number; right: number; bottom: number }

/** wire color: a style token. 'accent' is the highlighted path, the rest mark categories */
export type Hue = 'accent' | 'blue' | 'pink' | 'purple' | 'green' | 'amber'

export type ConnectOptions = {
  /** default gray (--line). the label takes the same color */
  color?: Hue
  dashed?: boolean
  /** side of the source box, picked from the layout when omitted */
  from?: Side
  /** side of the target box */
  to?: Side
  /** position along the source side, 0..1. default: middle of the overlap, or 0.5 */
  fromAt?: number
  /** position along the target side, 0..1 */
  toAt?: number
  /** text above a horizontal wire, right of a vertical one */
  label?: string
  /** smaller second line, below a horizontal wire */
  sub?: string
  /** extra classes for the label, e.g. 'mono' */
  labelClass?: string
  /** put the label on the line itself, hiding it (vertical wires) */
  mask?: boolean
  /** arrowhead at the source too */
  tail?: boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const GAP = 5 // arrow tip stops this far from the target box
const RADIUS = 9 // elbow corner radius

const jobs: (() => void)[] = []
let flush: Promise<void> | undefined

/** Draw an arrow from one element to another once layout and fonts are final. */
export function connect(from: string, to: string, opts: ConnectOptions = {}) {
  jobs.push(() => draw(from, to, opts))
  flush ??= track(
    document.fonts.ready
      .then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      .then(() => jobs.forEach((job) => job())),
  )
}

/** render.ts waits for every tracked promise before taking the screenshot */
export function track<T>(promise: Promise<T>): Promise<T> {
  const w = window as unknown as { __renderTasks?: Promise<unknown>[] }
  ;(w.__renderTasks ??= []).push(promise)
  return promise
}

function draw(fromId: string, toId: string, opts: ConnectOptions) {
  const a = document.getElementById(fromId)
  const b = document.getElementById(toId)
  if (!a || !b) throw new Error(`connect: no element with id "${a ? toId : fromId}"`)
  const canvas = a.closest<HTMLElement>('.canvas')
  if (!canvas) throw new Error('connect: elements must be inside .canvas')

  const origin = canvas.getBoundingClientRect()
  const rel = (el: Element): Rect => {
    const r = el.getBoundingClientRect()
    return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top }
  }
  const ra = rel(a)
  const rb = rel(b)
  const [fromSide, toSide] = pickSides(ra, rb, opts)
  const horizontal = (s: Side) => s === 'left' || s === 'right'

  // shared overlap on the cross axis gives a straight line
  let fromAt = opts.fromAt
  let toAt = opts.toAt
  if (fromAt === undefined && toAt === undefined && horizontal(fromSide) === horizontal(toSide)) {
    const [lo, hi] = horizontal(fromSide)
      ? [Math.max(ra.top, rb.top), Math.min(ra.bottom, rb.bottom)]
      : [Math.max(ra.left, rb.left), Math.min(ra.right, rb.right)]
    if (hi - lo > 12) {
      const mid = (lo + hi) / 2
      fromAt = horizontal(fromSide) ? (mid - ra.top) / (ra.bottom - ra.top) : (mid - ra.left) / (ra.right - ra.left)
      toAt = horizontal(toSide) ? (mid - rb.top) / (rb.bottom - rb.top) : (mid - rb.left) / (rb.right - rb.left)
    }
  }
  const start = anchor(ra, fromSide, fromAt ?? 0.5, 0)
  const end = anchor(rb, toSide, toAt ?? 0.5, GAP)
  const points = route(start, end, fromSide, toSide)

  const svg = wiresSvg(canvas)
  const hue = opts.color ?? ''
  svg.appendChild(path(roundedPolyline(points, RADIUS), [hue, opts.dashed && 'dashed'].filter(Boolean).join(' ')))
  svg.appendChild(path(arrowHead(points[points.length - 2], points[points.length - 1]), hue))
  if (opts.tail) {
    const tailPoints: Point[] = [...points].reverse()
    tailPoints[tailPoints.length - 1] = anchor(ra, fromSide, fromAt ?? 0.5, GAP)
    svg.appendChild(path(arrowHead(tailPoints[tailPoints.length - 2], tailPoints[tailPoints.length - 1]), hue))
  }
  if (opts.label || opts.sub) addLabels(canvas, points, opts)
}

function pickSides(a: Rect, b: Rect, opts: ConnectOptions): [Side, Side] {
  const opposite: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }
  if (opts.from && opts.to) return [opts.from, opts.to]
  if (opts.from) return [opts.from, opposite[opts.from]]
  if (opts.to) return [opposite[opts.to], opts.to]
  const hGap = Math.max(b.left - a.right, a.left - b.right)
  const vGap = Math.max(b.top - a.bottom, a.top - b.bottom)
  // left-to-right reading: any horizontal separation wins
  if (hGap > 0 || hGap >= vGap) return b.left >= a.right ? ['right', 'left'] : ['left', 'right']
  return b.top >= a.bottom ? ['bottom', 'top'] : ['top', 'bottom']
}

function anchor(r: Rect, side: Side, at: number, gap: number): Point {
  const x = r.left + (r.right - r.left) * at
  const y = r.top + (r.bottom - r.top) * at
  if (side === 'left') return [r.left - gap, y]
  if (side === 'right') return [r.right + gap, y]
  if (side === 'top') return [x, r.top - gap]
  return [x, r.bottom + gap]
}

// orthogonal route: straight, one corner, or two corners through the midpoint
function route(s: Point, e: Point, fromSide: Side, toSide: Side): Point[] {
  const hFrom = fromSide === 'left' || fromSide === 'right'
  const hTo = toSide === 'left' || toSide === 'right'
  if (hFrom && hTo) {
    if (Math.abs(s[1] - e[1]) < 0.5) return [s, [e[0], s[1]]]
    const mx = (s[0] + e[0]) / 2
    return [s, [mx, s[1]], [mx, e[1]], e]
  }
  if (!hFrom && !hTo) {
    if (Math.abs(s[0] - e[0]) < 0.5) return [s, [s[0], e[1]]]
    const my = (s[1] + e[1]) / 2
    return [s, [s[0], my], [e[0], my], e]
  }
  return hFrom ? [s, [e[0], s[1]], e] : [s, [s[0], e[1]], e]
}

function wiresSvg(canvas: HTMLElement): SVGSVGElement {
  let svg = canvas.querySelector<SVGSVGElement>(':scope > svg.wires')
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'wires')
    canvas.appendChild(svg)
  }
  return svg
}

function path(d: string, cls: string) {
  const p = document.createElementNS(SVG_NS, 'path')
  p.setAttribute('d', d)
  if (cls) p.setAttribute('class', cls)
  return p
}

// labels go on the longest segment
function addLabels(canvas: HTMLElement, points: Point[], opts: ConnectOptions) {
  let best = 0
  let bestLen = -1
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
    if (len > bestLen) {
      bestLen = len
      best = i
    }
  }
  const [p, q] = [points[best], points[best + 1]]
  const cx = (p[0] + q[0]) / 2
  const cy = (p[1] + q[1]) / 2
  const vertical = Math.abs(p[0] - q[0]) < 0.5
  const place = (text: string, cls: string, x: number, y: number, transform: string) => {
    const el = document.createElement('div')
    el.className = `wire-label ${cls}`
    el.textContent = text
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.transform = transform
    canvas.appendChild(el)
  }
  const extra = [opts.color && `fg-${opts.color}`, opts.labelClass].filter(Boolean).join(' ')
  if (vertical) {
    if (opts.label && opts.mask) place(opts.label, `mask ${extra}`, cx, cy, 'translate(-50%, -50%)')
    else if (opts.label) place(opts.label, extra, cx + 12, cy, 'translateY(-50%)')
    return
  }
  if (opts.label) place(opts.label, extra, cx, cy - 12, 'translate(-50%, -50%)')
  if (opts.sub) place(opts.sub, 'sub', cx, cy + 15, 'translate(-50%, -50%)')
}

// open chevron, 6px deep and 10px tall, never dashed
function arrowHead(from: Point, tip: Point) {
  const [x0, y0] = from
  const [x1, y1] = tip
  const len = Math.hypot(x1 - x0, y1 - y0) || 1
  const ux = (x1 - x0) / len
  const uy = (y1 - y0) / len
  const bx = x1 - ux * 6
  const by = y1 - uy * 6
  return `M ${bx - uy * 5} ${by + ux * 5} L ${x1} ${y1} L ${bx + uy * 5} ${by - ux * 5}`
}

function roundedPolyline(points: Point[], radius: number) {
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [cx, cy] = points[i]
    const [nx, ny] = points[i + 1]
    const inLen = Math.hypot(cx - px, cy - py)
    const outLen = Math.hypot(nx - cx, ny - cy)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    d += ` L ${cx - ((cx - px) / inLen) * r} ${cy - ((cy - py) / inLen) * r}`
    d += ` Q ${cx} ${cy} ${cx + ((nx - cx) / outLen) * r} ${cy + ((ny - cy) / outLen) * r}`
  }
  const [lx, ly] = points[points.length - 1]
  return d + ` L ${lx} ${ly}`
}

// dashed boxes get an svg outline so dash length is controllable (css dashed borders are fixed)
for (const box of document.querySelectorAll('.box.dashed')) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'dash')
  svg.appendChild(document.createElementNS(SVG_NS, 'rect'))
  box.prepend(svg)
}
