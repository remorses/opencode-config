// Generic post-conversion cleanup for PDF→markdown outputs.
// Fixes the issue classes that pymupdf4llm/marker/docling leave behind.
// Usage:
//   bun clean.ts --md <file.md> --pdf-text <pdf-textlayer.txt> \
//     [--extra-noise <regex>] (repeatable, lines matching are removed)
// Generate the PDF text layer with pymupdf first:
//   uvx --from pymupdf python -c "
//   import pymupdf, pathlib, sys
//   doc = pymupdf.open(sys.argv[1])
//   pathlib.Path(sys.argv[2]).write_text('\n'.join(p.get_text() for p in doc))
//   " input.pdf /tmp/pdf-text.txt
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
function arg(name: string): string {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : ''
}
const extraNoise: RegExp[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extra-noise') extraNoise.push(new RegExp(args[i + 1], 'i'))
}

const MD = arg('--md')
const PDF_TEXT_FILE = arg('--pdf-text')
if (!MD || !PDF_TEXT_FILE) {
  console.error('usage: bun clean.ts --md <file.md> --pdf-text <txt> [--extra-noise <regex>]')
  process.exit(1)
}

const stats: Record<string, number> = {}
const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n)

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()

const pdfWords = norm(readFileSync(PDF_TEXT_FILE, 'utf-8')).split(' ').filter(Boolean)
const pdfTrigrams = new Set<string>()
for (let i = 0; i + 3 <= pdfWords.length; i++) {
  pdfTrigrams.add(pdfWords.slice(i, i + 3).join(' '))
}
function pdfCount(sentence: string): number {
  const t = norm(sentence).split(' ').filter(Boolean)
  if (t.length < 6) return 99
  let count = 0
  for (let i = 0; i + t.length <= pdfWords.length; i++) {
    if (pdfWords.slice(i, i + t.length).join(' ') === t.join(' ')) count++
  }
  return count
}

const isHeading = (l: string) => /^#{1,6}\s/.test(l)
const isImage = (l: string) => /^!\[.*\]\(.*\)\s*$/.test(l)
const isTable = (l: string) => /^\s*\|/.test(l)
const isBlank = (l: string) => l.trim() === ''

// 1. remove picture-OCR comment blocks entirely (images are saved separately)
function removePictureBlocks(lines: string[]): string[] {
  const out: string[] = []
  let inBlock = false
  for (const line of lines) {
    if (!inBlock && /^<!-- Start of picture text -->/.test(line.trim())) {
      inBlock = true
      bump('pictureBlocksRemoved')
      continue
    }
    if (inBlock) {
      if (/<!-- End of picture text -->/.test(line)) inBlock = false
      continue
    }
    if (/^\s*<!-- (Start of|End of )?picture text( End)? -->/.test(line.trim())) continue
    out.push(line)
  }
  return out
}

// 2. remove OCR garbage lines / prefixes, verified against the PDF text layer
function garbageFilter(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const skip =
      isBlank(line) || isHeading(line) || isImage(line) || isTable(line) ||
      /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)
    if (skip) {
      out.push(line)
      continue
    }
    const w = norm(line).split(' ').filter(Boolean)
    let first = -1
    for (let i = 0; i + 3 <= w.length; i++) {
      if (pdfTrigrams.has(w.slice(i, i + 3).join(' '))) {
        first = i
        break
      }
    }
    if (first === -1) {
      if (w.length < 3) out.push(line)
      else bump('garbageLinesRemoved')
      continue
    }
    if (first > 0) {
      const raw = line.split(/\s+/)
      const keep = raw.length - (w.length - first)
      if (keep > 0 && keep < raw.length) {
        out.push(raw.slice(keep).join(' '))
        bump('garbagePrefixTrimmed')
      } else {
        out.push(line)
      }
    } else {
      out.push(line)
    }
  }
  return out
}

// 3. demote headings that are actually body sentences
function demoteBogusHeadings(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!isHeading(line)) {
      out.push(line)
      continue
    }
    const inner = line.replace(/^#+\s*/, '').trim()
    const text = inner.replace(/[*_]/g, '').trim()
    const next = lines.slice(i + 1).find((l) => !isBlank(l)) ?? ''
    const nextLower = /^[a-z]/.test(next.trim().replace(/[*_#]/g, ''))
    const level = (line.match(/^#+/) ?? ['#'])[0].length
    const bogus =
      /[.,;]$/.test(text) ||
      /^_[^_]+_$/.test(inner) ||
      (text.endsWith(':') && nextLower) ||
      (level >= 4 && text.split(/\s+/).length > 8 && (nextLower || isHeading(next)))
    if (bogus) {
      bump('bogusHeadingsDemoted')
      out.push(line.replace(/^#+\s*/, ''))
    } else {
      out.push(line)
    }
  }
  return out
}

// 4. restore headings the converter fused into paragraphs, using the TOC table
function processLineForTitles(line: string, titles: string[], done: Set<string>): string[] {
  const pieces: string[] = []
  let rest = line
  let guard = 0
  while (guard++ < 20) {
    let bestIdx = -1
    let bestTitle = ''
    for (const title of titles) {
      if (done.has(title)) continue
      const idx = rest.indexOf(title)
      if (idx === -1) continue
      const before = rest.slice(0, idx).trim()
      if (idx > 0 && !/[.!?]\s*$/.test(before)) continue
      if (bestIdx === -1 || idx < bestIdx) {
        bestIdx = idx
        bestTitle = title
      }
    }
    if (bestIdx === -1) break
    const before = rest.slice(0, bestIdx).trim()
    const after = rest.slice(bestIdx + bestTitle.length).trim()
    done.add(bestTitle)
    if (before) pieces.push(before)
    pieces.push('', `## ${bestTitle}`, '')
    bump('headingsRestored')
    rest = after
  }
  if (rest.trim()) pieces.push(rest)
  return pieces
}

function restoreHeadings(lines: string[]): string[] {
  const titles: string[] = []
  for (const line of lines) {
    if (!isTable(line)) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 3) continue
    const cell = cells[1]
    if (!cell || /^[-: ]+$/.test(cell)) continue
    const title = cell
      .replace(/\*\*/g, '')
      .replace(/<br>.*$/, '')
      .replace(/\.{2,}\s*\d*$/, '') // dot leaders + page numbers
      .trim()
    if (title.length >= 8 && title.toLowerCase() !== 'table of contents') {
      titles.push(title)
    }
  }
  const uniq = [...new Set(titles)]
  bump('tocTitles', uniq.length)
  const done = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    if (isTable(line) || isHeading(line) || isImage(line) || isBlank(line)) {
      out.push(line)
      continue
    }
    out.push(...processLineForTitles(line, titles, done))
  }
  return out
}

// 5. dedupe sentences (converter duplication only; PDF-count guarded)
function dedupeSentences(lines: string[]): string[] {
  const seen = new Map<string, number>()
  const out: string[] = []
  for (const line of lines) {
    const skip = isBlank(line) || isHeading(line) || isImage(line) || isTable(line)
    if (skip) {
      out.push(line)
      continue
    }
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z"“']|_)/)
    const kept: string[] = []
    for (const s of sentences) {
      const key = norm(s)
      if (key.length < 40) {
        kept.push(s)
        continue
      }
      const prev = seen.get(key) ?? 0
      if (prev > 0 && pdfCount(s) <= 1) {
        bump('dupSentencesRemoved')
        continue
      }
      seen.set(key, prev + 1)
      kept.push(s)
    }
    if (kept.length) out.push(kept.join(' '))
  }
  return out
}

// 6. drop restored headings that duplicate a heading a few lines above
function dedupeHeadings(lines: string[]): string[] {
  return lines.filter((l, i) => {
    if (!/^## /.test(l)) return true
    for (let j = Math.max(0, i - 4); j < i; j++) {
      if (isHeading(lines[j]) && norm(lines[j]) === norm(l)) {
        bump('dupHeadingsRemoved')
        return false
      }
    }
    return true
  })
}

let lines = readFileSync(MD, 'utf-8').split('\n')
lines = removePictureBlocks(lines)
lines = lines.filter((line) => {
  const junk =
    /^\s*Property of Charles Floate Training/.test(line) ||
    /^\s*<u>www\.charlesfloatetraining\.com<\/u>\s*\d*\s*$/i.test(line) ||
    /^\s*\d+\s*-\s*WWW\.CHARLESFLOATETRAINING\.COM\s*$/i.test(line) ||
    extraNoise.some((re) => re.test(line))
  if (junk) bump('noiseLinesRemoved')
  return !junk
})
lines = garbageFilter(lines)
lines = demoteBogusHeadings(lines)
lines = restoreHeadings(lines)
lines = dedupeSentences(lines)
lines = dedupeHeadings(lines)

const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
writeFileSync(MD, text)
console.log(`${MD}: ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(', ') || 'no changes'}`)
