// Split a song into vocals and instrumental with Demucs on fal (fal-ai/demucs).
//
// Use this for MUSIC: karaoke tracks, acapellas, remixes, removing vocals from a song.
// Default model htdemucs_ft is the best Demucs on fal for vocals (fine-tuned, ~4x slower).
// Price: $0.0007 per second (about $0.13 for a 3 min song).
//
//   bun demucs.ts song.mp3                     -> song.vocals.wav + song.instrumental.wav
//   bun demucs.ts song.mp3 --stems             -> also song.drums.wav, song.bass.wav, song.other.wav
//   bun demucs.ts song.mp3 --model htdemucs_6s --stems   -> 6 stems incl. guitar, piano
//   bun demucs.ts https://x.com/a.mp3 --out ./stems --format mp3
//   bun demucs.ts song.mp3 --shifts 5          -> slightly better, slower and pricier
//
// Instrumental = drums + bass + other (+ guitar + piano) summed with ffmpeg, no normalization.
// For speech, sound effects, or "isolate the dog barking", use sam.ts instead.

import path from 'node:path'
import { rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { download, loadFalKey, log, outputTarget, resolveAudioUrl, runFal, type FalFile } from './fal.ts'

const MODELS = ['htdemucs_ft', 'htdemucs', 'htdemucs_6s', 'hdemucs_mmi', 'mdx', 'mdx_extra', 'mdx_q', 'mdx_extra_q']
const STEMS = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const
type Stem = (typeof STEMS)[number]

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    model: { type: 'string', default: 'htdemucs_ft' },
    format: { type: 'string', default: 'wav' },
    stems: { type: 'boolean', default: false },
    shifts: { type: 'string', default: '1' },
    help: { type: 'boolean', short: 'h' },
  },
})

const input = positionals[0]
if (!input || values.help) {
  console.error('usage: bun demucs.ts <file-or-url> [--out dir] [--model htdemucs_ft] [--format wav|mp3] [--stems] [--shifts 1-10]')
  process.exit(input ? 0 : 1)
}
if (!MODELS.includes(values.model)) throw new Error(`--model must be one of ${MODELS.join(', ')}`)
if (values.format !== 'wav' && values.format !== 'mp3') throw new Error('--format must be wav or mp3')

const key = loadFalKey()
const audioUrl = await resolveAudioUrl({ input, key })
const stems: Stem[] = values.model === 'htdemucs_6s' ? [...STEMS] : ['vocals', 'drums', 'bass', 'other']

const result = await runFal<Partial<Record<Stem, FalFile>>>({
  endpoint: 'fal-ai/demucs',
  key,
  input: {
    audio_url: audioUrl,
    model: values.model,
    stems,
    shifts: Number(values.shifts),
    output_format: values.format,
  },
})

const { dir, base } = outputTarget({ input, out: values.out })
const ext = values.format
const files: Partial<Record<Stem | 'instrumental', string>> = {}
for (const stem of stems) {
  const file = result[stem]
  if (!file) throw new Error(`fal returned no ${stem} stem: ${JSON.stringify(result)}`)
  const dest = path.join(dir, `${base}.${stem}.${ext}`)
  await download({ file, dest })
  files[stem] = dest
}

const accompaniment = stems.filter((stem) => stem !== 'vocals').map((stem) => files[stem]!)
const instrumental = path.join(dir, `${base}.instrumental.${ext}`)
log('mixing instrumental with ffmpeg')
await promisify(execFile)(
  'ffmpeg',
  [
    '-y',
    '-loglevel', 'error',
    ...accompaniment.flatMap((file) => ['-i', file]),
    '-filter_complex', `amix=inputs=${accompaniment.length}:normalize=0`,
    ...(ext === 'mp3' ? ['-b:a', '320k'] : []),
    instrumental,
  ],
  { timeout: 120_000 },
)
log(`saved ${instrumental}`)
files.instrumental = instrumental

// Keep only vocals + instrumental unless the user asked for every stem.
if (!values.stems) {
  for (const file of accompaniment) await rm(file)
  for (const stem of stems) if (stem !== 'vocals') delete files[stem]
}

console.log(JSON.stringify(files, null, 2))
