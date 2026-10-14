---
title: nextjs-style
description: Dark Next.js docs diagram palette. Near-black background, dark gray cards, gray arrows, saturated blue, pink, purple, green and amber with dark tinted fills. Geist and Geist Mono.
---

# nextjs-style

Palette from the Next.js caching docs diagram (`references/nextjs-caching.png`). Only the colors
and fonts change; layout, sizes, strokes and meaning of shapes are the same as
`../claude-style/DESIGN.md`. Read that file for the rules.

## Palette

| token          | hex       | use                                            |
| -------------- | --------- | ---------------------------------------------- |
| `--bg`         | `#0a0a0a` | canvas background                              |
| `--card`       | `#171717` | boxes, record cards                            |
| `--sunken`     | `#232323` | group containers, record header row            |
| `--ink`        | `#ededed` | headings, text on colored boxes                |
| `--ink-soft`   | `#c7c7c7` | emphasized numbers                             |
| `--muted`      | `#8f8f8f` | all other text                                 |
| `--line`       | `#878787` | arrows, chart axes                             |
| `--border`     | `#3d3d3d` | box and card outlines                          |
| `--divider`    | `#2a2a2a` | row separators, section divider                |
| `--grid`       | `#1f1f1f` | chart grid lines                               |
| `--accent`     | `#f2b342` | the one highlighted path (amber)               |
| `--blue`       | `#1d68c5` | "our system" outline, fill `--blue-fill` `#0b1f38` |
| `--pink`       | `#c14c70` | extra category, fill `#371523`                 |
| `--purple`     | `#8955a7` | extra category, fill `#251931`                 |
| `--green`      | `#49a45f` | extra category, fill `#1a2c1e`                 |
| `--amber`      | `#f2b342` | extra category, fill `#4c3d20`                 |
| `--bar`        | `#4d4d4d` | baseline series in bar charts                  |

Use all hues, like the reference: one hue per category on boxes, groups and their wires
(`class="box green"`, `connect(a, b, { color: 'green' })`). Amber is also the accent here, so
when a figure has an accent path, do not use amber as a category. Text on colored boxes is
`--ink`; blue labels use `--blue-text` `#4a8fe7` for contrast.

## Fonts

Geist and Geist Mono from Google Fonts, same sizes as claude-style.
