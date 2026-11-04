#!/usr/bin/env bun
// Measure sound effects without listening: duration, perceived loudness, peak, attack and
// brightness, so cues can be synced and balanced from numbers.
//
//   bun analyze.ts assets/sfx/*.mp3          table, loudest first
//   bun analyze.ts a.mp3 b.mp3 --json        one JSON object per file
//
// Columns:
//   lufs     perceived loudness (EBU R128 integrated, K-weighted, so highs count more than lows)
//   peak     sample peak in dBFS
//   onset    first moment above -30 dB from the peak (leading silence; sync from here)
//   hit      loudest 10 ms (put this on the visual event: start = event - hit)
//   centroid spectral centroid, the "brightness" of the sound
//   main     the 3 strongest frequencies
//   >4k      share of energy above 4 kHz (bells, chimes, clicks score high)

import { spawnSync } from 'node:child_process'

const SR = 44100
const FFT_SIZE = 2048
const HOP = 512
const ONSET_DB = -30
const HIT_WINDOW_S = 0.01
const HIGH_HZ = 4000
const MAIN_PEAKS = 3
const PEAK_MIN_RATIO = 2 ** (1 / 3) // main frequencies at least a third of an octave apart

type Report = {
  file: string
  duration: number
  lufs: number | null
  peakDb: number
  onset: number
  hit: number
  centroid: number
  main: number[]
  highShare: number
  character: string
}

// First channel only: summing to mono cancels sounds whose channels are phase inverted.
function decode(file: string) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-af', 'pan=mono|c0=c0', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  if (p.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${p.stderr}`)
  const buf = p.stdout as Buffer
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

// Integrated loudness. Short sounds are padded with silence: R128 measures 400 ms blocks and the
// silent ones fall under the -70 LUFS gate, so the result is the loudness of the sound itself.
function loudness(file: string) {
  const p = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'apad=pad_dur=1,ebur128', '-f', 'null', '-'], { encoding: 'utf8' })
  const summary = p.stderr.slice(p.stderr.lastIndexOf('Summary:'))
  const m = summary.match(/I:\s+(-?[\d.]+|-inf) LUFS/)
  return m && m[1] !== '-inf' ? Number(m[1]) : null
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

// Power spectrum summed over all frames, so loud frames weigh more.
function spectrum(x: Float32Array) {
  const power = new Float64Array(FFT_SIZE / 2)
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE))
  for (let start = 0; start === 0 || start + FFT_SIZE <= x.length; start += HOP) {
    const re = new Float64Array(FFT_SIZE)
    const im = new Float64Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) re[i] = (x[start + i] ?? 0) * window[i]
    fft(re, im)
    for (let k = 0; k < FFT_SIZE / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k]
  }
  return power
}

function analyze(file: string): Report {
  const x = decode(file)
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const threshold = peak * 10 ** (ONSET_DB / 20)
  const onsetIndex = x.findIndex((v) => Math.abs(v) >= threshold)

  const win = Math.round(HIT_WINDOW_S * SR)
  let best = 0
  let hitIndex = 0
  for (let i = 0; i + win <= x.length; i += win) {
    let e = 0
    for (let j = i; j < i + win; j++) e += x[j] * x[j]
    if (e > best) [best, hitIndex] = [e, i]
  }

  const power = spectrum(x)
  const hz = (k: number) => (k * SR) / FFT_SIZE
  let total = 0
  let weighted = 0
  let high = 0
  for (let k = 1; k < power.length; k++) {
    total += power[k]
    weighted += power[k] * hz(k)
    if (hz(k) >= HIGH_HZ) high += power[k]
  }
  const centroid = total ? weighted / total : 0
  const peaks = [...power.keys()].filter((k) => k > 1 && k < power.length - 1 && power[k] > power[k - 1] && power[k] >= power[k + 1]).sort((a, b) => power[b] - power[a])
  const main: number[] = []
  for (const k of peaks) {
    if (main.every((f) => Math.max(f, hz(k)) / Math.min(f, hz(k)) >= PEAK_MIN_RATIO)) main.push(hz(k))
    if (main.length === MAIN_PEAKS) break
  }
  const highShare = total ? high / total : 0
  const character = centroid < 800 ? 'low' : centroid < 2500 ? 'mid' : centroid < 5000 ? 'bright' : 'very bright'

  return {
    file,
    duration: x.length / SR,
    lufs: loudness(file),
    peakDb: 20 * Math.log10(peak || 1e-9),
    onset: Math.max(0, onsetIndex) / SR,
    hit: (hitIndex + win / 2) / SR,
    centroid,
    main,
    highShare,
    character,
  }
}

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.log('usage: bun analyze.ts <file...> [--json]')
  process.exit(1)
}
const reports = files.map(analyze).sort((a, b) => (b.lufs ?? -99) - (a.lufs ?? -99))
if (args.includes('--json')) {
  for (const r of reports) console.log(JSON.stringify(r))
} else {
  const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`)
  const rows = reports.map((r) => [
    r.file.split('/').pop()!,
    r.duration.toFixed(2),
    r.lufs == null ? '-' : r.lufs.toFixed(1),
    r.peakDb.toFixed(1),
    r.onset.toFixed(3),
    r.hit.toFixed(3),
    fmtHz(r.centroid),
    r.main.map(fmtHz).join(' '),
    `${Math.round(r.highShare * 100)}%`,
    r.character,
  ])
  const head = ['file', 'dur', 'lufs', 'peak', 'onset', 'hit', 'centroid', 'main', '>4k', 'character']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '))
}
