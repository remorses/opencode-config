// Isolate any sound described in text with Meta SAM Audio on fal (fal-ai/sam-audio/*).
//
// Use this for NON-MUSIC or custom targets: a speaker's voice over background noise,
// dialogue from a video, a dog barking, a siren, one instrument by description.
// For plain song vocals vs instrumental, demucs.ts is cheaper and tuned for music.
// Price: $0.05 per 30s of output, +$0.025 per 30s per extra reranking candidate
// (about $0.30 for 3 min with --candidates 1).
//
//   bun sam.ts clip.mp3 --prompt 'man speaking'            -> clip.target.wav + clip.residual.wav
//   bun sam.ts song.mp3 --prompt 'female singing voice'    -> target = vocals, residual = the rest
//   bun sam.ts street.wav --prompt 'dog barking' --candidates 3 --acceleration quality
//   bun sam.ts talk.mp3 --prompt 'man speaking' --predict-spans   -> model finds where it occurs
//   bun sam.ts talk.mp3 --span 6-10 --span 31.5-40         -> fal-ai/sam-audio/span-separate
//   bun sam.ts talk.mp3 --prompt 'cough' --span 12-14 --exclude-span 20-22 --trim
//
// target = the sound matching the prompt/spans, residual = everything else.

import path from 'node:path'
import { parseArgs } from 'node:util'
import { download, loadFalKey, outputTarget, resolveAudioUrl, runFal, type FalFile } from './fal.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: 'string' },
    span: { type: 'string', multiple: true, default: [] },
    'exclude-span': { type: 'string', multiple: true, default: [] },
    trim: { type: 'boolean', default: false },
    'predict-spans': { type: 'boolean', default: false },
    candidates: { type: 'string', default: '1' },
    acceleration: { type: 'string', default: 'balanced' },
    format: { type: 'string', default: 'wav' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const input = positionals[0]
if (!input || values.help) {
  console.error(
    "usage: bun sam.ts <file-or-url> --prompt 'what to isolate' [--span start-end ...] [--exclude-span start-end ...]\n" +
      '       [--trim] [--predict-spans] [--candidates 1-7] [--acceleration fast|balanced|quality] [--format wav|mp3] [--out dir]',
  )
  process.exit(input ? 0 : 1)
}

function parseSpan(value: string, include: boolean) {
  const match = value.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/)
  if (!match) throw new Error(`span must be start-end in seconds, got ${value}`)
  return { start: Number(match[1]), end: Number(match[2]), include }
}

const spans = [
  ...values.span.map((value) => parseSpan(value, true)),
  ...values['exclude-span'].map((value) => parseSpan(value, false)),
]
if (!values.prompt && spans.length === 0) throw new Error('pass --prompt, --span, or both')
if (!['fast', 'balanced', 'quality'].includes(values.acceleration)) {
  throw new Error('--acceleration must be fast, balanced or quality')
}
if (values.format !== 'wav' && values.format !== 'mp3') throw new Error('--format must be wav or mp3')

const key = loadFalKey()
const audioUrl = await resolveAudioUrl({ input, key })
const common = {
  audio_url: audioUrl,
  prompt: values.prompt,
  reranking_candidates: Number(values.candidates),
  acceleration: values.acceleration,
  output_format: values.format,
}

const result = await runFal<{ target: FalFile; residual: FalFile; duration: number }>(
  spans.length > 0
    ? {
        endpoint: 'fal-ai/sam-audio/span-separate',
        key,
        input: {
          ...common,
          spans,
          trim_to_span: values.trim,
          use_sound_activity_ranking: Number(values.candidates) > 1,
        },
      }
    : {
        endpoint: 'fal-ai/sam-audio/separate',
        key,
        input: { ...common, predict_spans: values['predict-spans'] },
      },
)

const { dir, base } = outputTarget({ input, out: values.out })
const files = {
  target: path.join(dir, `${base}.target.${values.format}`),
  residual: path.join(dir, `${base}.residual.${values.format}`),
}
await download({ file: result.target, dest: files.target })
await download({ file: result.residual, dest: files.residual })

console.log(JSON.stringify({ ...files, duration: result.duration }, null, 2))
