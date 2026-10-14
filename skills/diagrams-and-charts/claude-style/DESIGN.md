---
title: claude-style
description: Anthropic engineering blog look. Warm off-white background, gray strokes, one clay-orange accent, Inter and JetBrains Mono.
---

# claude-style

Based on three Anthropic engineering blog figures (see `references/`). Everything is flat:
no shadows, no gradients, no icons. Meaning comes from **color role**, **stroke style** and
**position**, never decoration.

```
┌─ canvas #fafbf8, 1060px wide, square corners, 32px padding ─────────────┐
│ Section label 18/600 muted (optional)                                   │
│                                                                         │
│  ┌ box white ┐ ─────label 13.5/600─────▶ ┌ box blue ┐                   │
│  └───────────┘                           └──────────┘                   │
│ ─────────────────────────── divider between sections ────────────────── │
│ Section label                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

The image is **only the figure**: no page frame, no title, no rounded outer corners. The blog
post supplies the title and caption. Keep the 32px padding so the figure breathes.

## Palette

| token         | hex       | use                                                         |
| ------------- | --------- | ----------------------------------------------------------- |
| `--bg`        | `#fafbf8` | canvas background                                           |
| `--card`      | `#ffffff` | boxes, record cards                                         |
| `--sunken`    | `#efeee5` | group containers, record header row                         |
| `--ink`       | `#141413` | chart section headings                                      |
| `--ink-soft`  | `#3a3a38` | emphasized numbers (ratio column)                           |
| `--muted`     | `#72736e` | all other text; `--line` (arrows) and `--border` (outlines) are the same gray |
| `--divider`   | `#d3d4cd` | row separators inside cards                                 |
| `--grid`      | `#e6e7e0` | chart grid lines                                            |
| `--accent`    | `#d97757` | the one highlighted path: hashes, ids, hot data flow, "new" |
| `--blue`      | `#5290c8` | stroke of "our services" boxes                              |
| `--blue-fill` | `#edf5fb` | fill of "our services" boxes                                |
| `--green`     | `#5f9a6d` | category hue, fill `--green-fill` `#eef6f0` (clients, users) |
| `--purple`    | `#8a72c2` | category hue, fill `#f3effa` (cloud, third party)            |
| `--pink`      | `#c4688a` | category hue, fill `#fbeef3` (devices, targets)              |
| `--amber`     | `#c99a3e` | category hue, fill `#fbf5e8` (storage)                       |
| `--bar`       | `#74726c` | baseline series in bar charts                               |

Gray is the default. Accent marks **one** story per figure (the data path, the content hash,
the new system). Blue marks the system being described. Green, purple, pink and amber mark
**categories**: one hue per kind of thing, same hue on its boxes and its wires. Use them;
a figure with only gray and blue is harder to scan.

## Typography

Inter and JetBrains Mono from Google Fonts (imported by `style.css`). This file also holds the
layout and shape rules shared by every style.

| role                       | font | size | weight | color |
| -------------------------- | ---- | ---- | ------ | ----- |
| section label, chart heading | sans | 18   | 600    | muted / ink |
| box text                   | sans | 14.5 | 600 (`.medium` 500 for quiet boxes) | muted |
| wire label, chart label    | sans | 13.5 | 600    | muted or accent |
| sub line, notes            | sans | 12.5 to 13.5 | 500 | muted |
| identifiers, keys, hashes  | mono | 13.5 | 600 key, 400 value | muted or accent |

Sentence case everywhere. Short labels. Abbreviate hashes with `…` (`9f2c…7ab0`).

## Meaning of shapes

- **Solid box**: a thing that exists. **Dashed box**: derived, virtual, not stored.
  **Group** (sunken): a set of similar things. **Blue box**: the system the post is about.
- Arrows are thin with an open chevron head. Dashed arrow: derived or occasional.
  Accent arrow: the highlighted data path.
- Stroke `1.75px` everywhere. Radius 8 boxes, 9 cards. The canvas is a plain rectangle.

## Layout

Never position by coordinates. Put boxes in a `.flow` grid inside the `.canvas` and place them by
cell: `style="grid-area: row / col"` or `grid-area: row / col / rowEnd` to span rows. Boxes
stretch to their column width; add `justify-self: start` to fit content.

- Data flows **left to right**; storage or derived things go **below**.
- Leave empty cells where long wire labels must fit.
- `--col-gap` / `--row-gap` on the `.flow` change spacing. `align-self: stretch` makes a tall box.

## Components

| class / helper | what |
| -------------- | ---- |
| `.canvas#diagram` | the image: 1060px wide, light background, padding |
| `.section`, `.section-label` | optional regions in one figure, split by a divider |
| `.flow` | grid of boxes |
| `.box` (+ `.node`, `.group`, `.row`, `.sunken`, `.dashed`, hues `.blue .green .purple .pink .amber`) | boxes: plain, title + `.sub` lines, sunken container with a `.stack`, parts on one line |
| `.record`, `.record-head`, `.record-row` | struct card: key, value, optional `.note` |
| `.text` | plain cell, e.g. `…` after the last box |
| `.mono .accent .ink .medium .sub .note .fg-<hue>` | text utilities |
| `connect(fromId, toId, opts)` in `/skill/diagram.ts` | arrow between elements, routed from layout |
| `barChart(selector, spec)` in `/skill/charts.ts` | grouped horizontal bar chart from data |

`connect` options: `color` (`'accent'` or a hue; the label takes it), `dashed`, `label`, `sub`, `labelClass` (`'mono'`),
`mask` (label on a vertical line), `from` / `to` sides, `fromAt` / `toAt` (0..1 along a side),
`tail`. Boxes that overlap on the cross axis get a straight arrow through the overlap middle.

## Bar charts

- Horizontal bars, series per row (gray baseline, accent new, more series take hues; override
  with `colors`). Value label after each bar.
- Optional right columns: ratio (`×25`) and a note.
- Very different scales go in separate stacked charts, not a log axis.
- One axis title at the bottom. Legend box sits on the first heading row.
- Row labels are right-aligned in a ~230px column; keep them short.
