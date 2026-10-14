// Horizontal grouped bar chart, rendered as one svg inside the .canvas.
//
//   <div class="canvas" id="diagram"></div>
//   <script type="module">
//     import { barChart } from '/skill/charts.ts'
//     barChart('#diagram', {
//       series: ['git', 'scn'],                    // first is gray, then accent, blue, pink...
//       colors: ['bar', 'green'],                  // optional token names per series
//       ratioHeader: 'Faster',                     // optional right column header
//       axisTitle: 'Median time',                  // optional, under the last chart
//       charts: [
//         {
//           title: 'Developer environments',       // optional section heading
//           legend: true,                          // legend box on the heading row
//           max: 100, ticks: [0, 20, 40, 60, 80, 100], unit: (v) => `${v} s`,
//           rows: [{ label: 'Pull latest', values: [87, 3.5], text: ['87 s', '3.5 s'], ratio: '×25', note: '' }],
//         },
//       ],
//     })
//   </script>
//
// Geometry is in css px for the 1060px canvas. The canvas height is set from the content.

const SVG_NS = 'http://www.w3.org/2000/svg'

const L = {
  plotX: 275,
  plotW: 455.5,
  labelRight: 252, // row labels are right-aligned here
  ratioX: 782,
  noteX: 829,
  firstHeadingY: 50.5, // center y of the first heading row
  headingToChart: 23.5, // heading center to chart top
  legendToChart: 30, // when the heading row has a legend
  chartGap: 46.5, // chart bottom to next chart top, no heading
  sectionGap: 80.5, // chart bottom to next chart top, with heading
  padTop: 11.5, // chart top to first bar
  padBottom: 11, // last bar to axis
  bar: 18,
  barGap: 1.5,
  groupGap: 20.2,
  valueGap: 6.7, // bar end to value label
  tickLabelY: 18, // axis to tick label center
  tickLen: 5.5,
  axisTitleY: 51, // last axis to axis title center
  padBottomRoot: 41.5,
}

export type BarRow = {
  label: string
  /** one value per series, in the chart unit */
  values: number[]
  /** value labels shown after each bar */
  text: string[]
  /** right column, e.g. ×25 */
  ratio?: string
  /** far right column */
  note?: string
}

export type BarChartSection = {
  title?: string
  legend?: boolean
  max: number
  ticks: number[]
  unit: (v: number) => string
  rows: BarRow[]
}

export type BarChartSpec = {
  /** first series is gray, second is accent, then blue, pink, purple, green, amber */
  series: string[]
  /** override series colors with token names: 'bar', 'accent', 'blue', 'pink', 'purple', 'green', 'amber' */
  colors?: string[]
  ratioHeader?: string
  axisTitle?: string
  charts: BarChartSection[]
}

/** Render stacked grouped bar charts into the .canvas and set its height. */
export function barChart(target: string | HTMLElement, spec: BarChartSpec) {
  const root = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
  if (!root) throw new Error(`barChart: no element matches ${String(target)}`)
  const svg = el('svg', { class: 'chart' })
  root.appendChild(svg)
  const tokens = spec.colors ?? ['bar', 'accent', 'blue', 'pink', 'purple', 'green', 'amber']
  const colors = spec.series.map((_, i) => `var(--${tokens[i % tokens.length]})`)

  let y = L.firstHeadingY
  let chartTop = 0
  let prevBottom = 0
  spec.charts.forEach((chart, i) => {
    if (i === 0) {
      chartTop = chart.title || chart.legend ? y + (chart.legend ? L.legendToChart : L.headingToChart) : 0
    } else {
      chartTop = prevBottom + (chart.title ? L.sectionGap : L.chartGap)
      y = chartTop - L.headingToChart
    }
    if (chart.title) text(svg, L.plotX, y, chart.title, 'heading')
    if (i === 0 && spec.ratioHeader) text(svg, L.ratioX, y + 1.3, spec.ratioHeader, 'ratio-header')
    if (chart.legend) legend(root, spec.series, colors, y)

    const groupH = spec.series.length * L.bar + (spec.series.length - 1) * L.barGap
    const plotH = L.padTop + chart.rows.length * (groupH + L.groupGap) - L.groupGap + L.padBottom
    const bottom = chartTop + plotH
    const xOf = (v: number) => L.plotX + (v / chart.max) * L.plotW

    for (const t of chart.ticks) {
      const x = xOf(t)
      if (t !== 0) svg.appendChild(el('line', { class: 'grid', x1: x, x2: x, y1: chartTop, y2: bottom }))
      svg.appendChild(el('line', { class: 'axis', x1: x, x2: x, y1: bottom, y2: bottom + L.tickLen }))
      text(svg, x, bottom + L.tickLabelY, chart.unit(t), 'tick')
    }

    chart.rows.forEach((row, r) => {
      const gy = chartTop + L.padTop + r * (groupH + L.groupGap)
      text(svg, L.labelRight, gy + groupH / 2, row.label, 'row-label')
      row.values.forEach((v, s) => {
        const by = gy + s * (L.bar + L.barGap)
        const w = Math.max(xOf(v) - L.plotX, 0)
        svg.appendChild(el('path', { d: barPath(L.plotX, by, w, L.bar, 3), fill: colors[s] }))
        text(svg, L.plotX + w + L.valueGap, by + L.bar / 2, row.text[s], 'value')
      })
      if (row.ratio) text(svg, L.ratioX, gy + groupH / 2, row.ratio, 'ratio')
      if (row.note) text(svg, L.noteX, gy + groupH / 2, row.note, 'note')
    })

    // axes on top of bars and grid
    svg.appendChild(el('line', { class: 'axis', x1: L.plotX, x2: L.plotX, y1: chartTop, y2: bottom }))
    svg.appendChild(el('line', { class: 'axis', x1: L.plotX, x2: L.plotX + L.plotW, y1: bottom, y2: bottom }))
    prevBottom = bottom
  })

  let end = prevBottom
  if (spec.axisTitle) {
    end = prevBottom + L.axisTitleY
    text(svg, L.plotX + L.plotW / 2, end, spec.axisTitle, 'axis-title')
  }
  root.style.height = `${end + L.padBottomRoot}px`
}

// html, not svg, so it sizes itself to the labels once fonts load
function legend(root: HTMLElement, series: string[], colors: string[], cy: number) {
  const box = document.createElement('div')
  box.className = 'legend'
  box.style.right = `${root.clientWidth - (L.plotX + L.plotW)}px`
  box.style.top = `${cy}px`
  series.forEach((name, i) => {
    const sw = document.createElement('i')
    sw.style.background = colors[i]
    box.append(sw, name)
  })
  root.appendChild(box)
}

function barPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2)
  return `M ${x} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${y + h - rr} Q ${x + w} ${y + h} ${x + w - rr} ${y + h} H ${x} Z`
}

function text(parent: Element, x: number, y: number, content: string, cls: string) {
  const t = el('text', { x, y, class: cls })
  t.textContent = content
  parent.appendChild(t)
  return t
}

function el(name: string, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}
