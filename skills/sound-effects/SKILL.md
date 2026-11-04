---
name: sound-effects
description: >
  Find, audition and place sound effects for a video (HyperFrames, Remotion, ffmpeg edits) with
  Openverse (api.openverse.org, CC0 sounds from Freesound). Covers copying the sound design of a
  reference video (the gemini subagent reads the media file and lists its effects and search
  terms), the openverse.ts CLI (search, get with credits, audition reel), picking by ear with the
  gemini subagent, trimming and normalizing with ffmpeg, syncing cues to visible actions, and
  Tommy's taste rules (few cues, no repeated pops, a different whoosh for each scene). Use when
  the user asks for sound effects, sfx, sound design, whooshes, pops or clicks in a video.
---

# sound-effects

**Whenever you need sound effects, search Openverse to find the best options and use them for
tasteful sound design within the video.** Few cues, each on a visible action, quiet under the music.

```bash
SFX=~/.config/opencode/skills/sound-effects/openverse.ts
ov() { sigillo run -p 01M6KWJ82P6XSS7M4YWTK5HSWW -c dev -- bun $SFX "$@"; }   # Sigillo org skills
ov search "airy whoosh" --max-ms 2000           # id, length, license, title, tags
ov get <id> assets/sfx/whoosh-soft.mp3 --credits assets/sfx/CREDITS.md
bun $SFX reel /tmp/reel.mp4 a.mp3 b.mp3 c.mp3   # audition video + start time of each
```

Use a shell function, not a `RUN='sigillo run ...'` variable: zsh runs `$RUN` as one command name.

## Preferences

Tommy's rules, learned from feedback. Follow them before anything else.

- **Less is more.** Do not put a sound on every element. Pick the key moments: a landing, a sent
  message, a cut, the logo. Groups of things that appear together (icons, words of a title) get
  one sound or none, never one each.
- **No pops and bubble bops.** Bright bubble pops get annoying fast. For chat bubbles use a soft,
  low tap (low-passed around 5 kHz, volume ~0.35), and only on the important messages.
- **Never repeat the same sound across scenes.** Every scene cut and scene entry gets a
  different whoosh (riser, sub, digital, slide, sweep...). A sound may repeat only inside one
  scene when the repeats are close in time, like 3 camera moves or a row of taps.
- **No doubled cues.** If two sounds land within ~0.4 s of each other (a cut whoosh and a "phone
  rises" whoosh, a tap and an "app opens" whoosh), keep one.
- **Copy the reference's density,** not more. If the original has 9 effects in 20 s, do not
  place 60 in 35 s.
- **Not cheesy:** no 8-bit, cartoon boings, kung-fu stick swishes, vocal or breathy sounds.

## Workflow

1. **Copy the reference.** When there is an original or reference video, start a `gemini`
   subagent and tell it to read the media file itself (its `read-video-or-audio` tool, absolute
   path) and list every sound effect: timestamp, what happens on screen, a description, and 2-3
   search queries. Do not use `describe-media` for this. Use its queries and its density, not
   your own guesses. Check its timestamps against the composition's real timings: they are
   often 0.5-1 s off.
2. **Search** each family (whoosh, tap, thud, typing, chime, sparkle, impact). Default is
   `--license cc0`. Keep `--max-ms` short: UI sounds under 1 s, whooshes under 2 s. Queries of 1-2
   words work best ("typing", "soft tick", "deep whoosh"); use `--page 2` for more. For whooshes
   you need many distinct ones, so search several angles: "reverse whoosh", "whoosh soft",
   "deep whoosh", "woosh", "swoosh --page 2", "transition".
3. **Download 3-5 candidates per family** with `get --credits`, then **audition by ear**: build a
   reel per family (`reel`) and send it to the `gemini` subagent with the printed start times, so
   it reads the reel file and listens. Ask for a 1-5 score for the video's style and to reject
   cheesy, noisy or vocal sounds. Its scores vary between calls: use them to reject bad sounds,
   not to rank close ones. Measure brightness and length yourself (librosa spectral centroid,
   RMS peak time) to tell candidates apart.
4. **Trim and normalize** the picks into the project (`assets/sfx/<role>.mp3`): cut leading silence,
   fade long tails, peak at -1 dB, so volumes are set only in the cue sheet.

   ```bash
   ffmpeg -i in.mp3 -af "silenceremove=start_periods=1:start_threshold=-50dB,afade=t=out:st=0.9:d=0.5,volume=6dB" -ar 48000 -ac 2 out.mp3
   ```

5. **Place cues on visible actions**, read from the composition's timing constants, not by eye.
   Start each sound so its **loudest point** (RMS peak) lands on the event: `start = event - peak`.
   A whoosh peaks at the cut, a thud when the object lands. Volumes 0.2-0.45 under music at ~0.8.

## Gotchas

- **Rate limit:** anonymous calls allow `page_size <= 20` and a short burst, then Cloudflare answers
  429 with an HTML page for a few minutes. Run through `ov` (bearer token from the client
  credentials in Sigillo) and `sleep 2` between searches in loops.
- **Gemini timing is coarse.** It cannot tell sounds less than ~1 s apart. Keep reel gaps at 0.6 s
  and pass the exact start times; for close calls send one file per reel.
- **You cannot hear.** Always tell the user to check the mix by ear.
- Openverse `category=sound_effect` filters out almost everything; leave it off. Many "whoosh"
  results are martial-arts stick swings (qubodup, Nightflame, Joao_Janz); skip them.
- HyperFrames: every `<audio>` needs an `id`, and two cues on one `data-track-index` must not
  overlap (`duplicate_audio_track`). Give each cue the first free track.
- Keep `CREDITS.md` next to the sounds even for CC0: it records the source URL of every file.
