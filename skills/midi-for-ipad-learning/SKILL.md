---
name: midi-for-ipad-learning
description: >
  Find a piano MIDI for a song, transpose it to white keys only (C major / A minor),
  split it into full, right hand and left hand files, and save them in an iCloud Drive
  folder named `<song>-midi` for piano learning on iPad with midee.app. Use when the user
  asks for piano MIDI files of a song, white-keys or C major versions, or MIDI for midee.
---

# midi-for-ipad-learning

Goal: for each song, 3 MIDI files with only white keys, in iCloud Drive. The user loads them on iPad in **midee.app** (https://midee.app).

```
~/Library/Mobile Documents/com~apple~CloudDocs/<song>-midi/
  <song>-full.mid         # track "Right Hand" + track "Left Hand"
  <song>-right-hand.mid
  <song>-left-hand.mid
```

`<song>` is kebab-case, e.g. `golden-brown-midi`. The `-midi` suffix lets the user find the folders.

## 1. find a piano MIDI on MuseScore

MuseScore has the most **piano solo** arrangements (2 tracks: right hand, left hand). curl gets 403 (Cloudflare), so use playwriter (load the `playwriter` skill first). `scripts/musescore.mjs` searches and downloads the MIDI without login.

```bash
playwriter session new   # then use its id with -s
playwriter -s <id> --timeout 120000 -e '
const m = await import("/Users/morse/.config/opencode/skills/midi-for-ipad-learning/scripts/musescore.mjs")
state.page ??= await context.newPage()
const r = await m.searchMusescore({ page: state.page, query: "golden brown stranglers piano solo" })
console.log(r.slice(0, 10).map(x => (x.official ? "[OFFICIAL] " : "") + x.url + " | " + x.title).join("\n"))'
```

Pick a result:

- skip `[OFFICIAL]` scores (paid) and duets, vocal or other instrument versions
- prefer titles with "piano", "piano solo"; "easy" when the user is a beginner
- for ambiguous names, pick the version that fits the other songs (e.g. "Love Story" = Indila)

```bash
playwriter -s <id> --timeout 120000 -e '
const m = await import("/Users/morse/.config/opencode/skills/midi-for-ipad-learning/scripts/musescore.mjs")
await m.downloadMusescoreMidi({ page: state.page, url: "https://musescore.com/user/34400169/scores/7209879", outputPath: "/tmp/midi/golden-brown.mid" })'
```

Fallback: https://freemidi.org (band arrangements, not piano). Page `/download3-<id>-<slug>`, file `/getter-<id>` with the page as referer and a cookie jar. bitmidi.com is often down. GitHub code search does not index `.mid` files.

## 2. transpose to white keys and split hands

```bash
uv run /Users/morse/.config/opencode/skills/midi-for-ipad-learning/scripts/white-keys.py /tmp/midi/golden-brown.mid \
  --out ~/Library/Mobile\ Documents/com~apple~CloudDocs/golden-brown-midi --name golden-brown
```

What it does:

1. tries every shift from -6 to +5 semitones, keeps the one with most notes (duration weighted) on white keys. That is C major or A minor
2. snaps leftover black keys one semitone down (G# to G). Prints how many. Use `--no-snap` to keep them
3. splits hands with a beam search over chords: max 5 notes and a 9th (14 semitones) per hand, counting held notes; costs for stretches, jumps and crossing. With 2 source tracks (MuseScore staves) it keeps the arranger's staff and moves a note only to fix an unplayable moment. `--ignore-staves` splits by playability only. `--tracks 0,1` picks tracks
4. writes the 3 files with tempo, time signature, sustain pedal and a C / Am key signature

## 3. check the split

```bash
uv run /Users/morse/.config/opencode/skills/midi-for-ipad-learning/scripts/midi-info.py <song>-full.mid --worst 6
```

Prints per hand: range, chord sizes, max notes held, max span, and the hardest moments with timestamps. "over a 9th (unplayable)" must be 0. Run it on the source MIDI too, to see if a problem comes from the arrangement.

Chords of 3 or 4 notes in one hand (melody plus a held note, or a full triad) are normal in piano arrangements.

## 4. report

Tell the user per song: MuseScore source URL, semitone shift, and how many notes were snapped. Many snapped notes (over ~10%) change the song audibly; offer another arrangement or `--no-snap`.

Remind the user to open the files in **midee.app** on iPad from the Files app (iCloud Drive).
