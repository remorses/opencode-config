# /// script
# requires-python = ">=3.10"
# dependencies = ["mido"]
# ///
"""Print what each hand has to play: range, chord sizes, hand spans,
and the hardest moments. Use it to check a hand split.

uv run midi-info.py song.mid [--worst 8]
"""

import argparse
from collections import Counter

import mido

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
# a normal adult hand reaches a 9th (14 semitones) at most, an octave (12) comfortably
COMFORT_SPAN = 12
MAX_SPAN = 14


def name(n):
    return f'{NAMES[n % 12]}{n // 12 - 1}'


def notes_of(track, tpb, tempo_map):
    """[(start_sec, end_sec, pitch)] of one track."""
    out, start, t = [], {}, 0
    for msg in track:
        t += msg.time
        if msg.type == 'note_on' and msg.velocity > 0:
            start.setdefault(msg.note, []).append(t)
        elif msg.type in ('note_on', 'note_off') and start.get(msg.note):
            s = start[msg.note].pop(0)
            out.append((tempo_map(s), tempo_map(t), msg.note))
    return sorted(out)


def build_tempo_map(mid):
    changes, t = [], 0
    for msg in mido.merge_tracks(mid.tracks):
        t += msg.time
        if msg.type == 'set_tempo':
            changes.append((t, msg.tempo))
    changes = changes or [(0, 500000)]
    if changes[0][0] != 0:
        changes.insert(0, (0, 500000))

    def to_sec(tick):
        sec, prev_t, prev_tempo = 0.0, 0, changes[0][1]
        for ct, tempo in changes:
            if ct >= tick:
                break
            sec += (ct - prev_t) * prev_tempo / 1e6 / mid.ticks_per_beat
            prev_t, prev_tempo = ct, tempo
        return sec + (tick - prev_t) * prev_tempo / 1e6 / mid.ticks_per_beat

    return to_sec


def analyze(notes, worst):
    if not notes:
        print('  no notes')
        return
    pitches = [p for _, _, p in notes]
    print(f'  {len(notes)} notes, range {name(min(pitches))}..{name(max(pitches))}')

    # chords: notes that start together (within 30 ms)
    chords, cur = [], [notes[0]]
    for n in notes[1:]:
        if n[0] - cur[0][0] < 0.03:
            cur.append(n)
        else:
            chords.append(cur)
            cur = [n]
    chords.append(cur)
    sizes = Counter(len(c) for c in chords)
    print(f'  chord sizes (notes struck together): {dict(sorted(sizes.items()))}')

    # held: everything sounding at each onset (what the hand must hold down)
    moments = []
    for c in chords:
        t = c[0][0]
        held = sorted({p for s, e, p in notes if s <= t + 0.03 and e > t + 0.03})
        if held:
            moments.append((t, held))
    spans = [h[-1] - h[0] for _, h in moments]
    too_wide = sum(s > MAX_SPAN for s in spans)
    wide = sum(COMFORT_SPAN < s <= MAX_SPAN for s in spans)
    print(f'  held at once: max {max(len(h) for _, h in moments)} notes, max span {max(spans)} semitones')
    print(f'  moments over an octave: {wide}, over a 9th (unplayable for one hand): {too_wide} of {len(moments)}')
    hard = sorted(moments, key=lambda m: (m[1][-1] - m[1][0], len(m[1])), reverse=True)[:worst]
    for t, held in sorted(hard):
        print(f'    {int(t // 60)}:{t % 60:04.1f}  span {held[-1] - held[0]:2d}  {" ".join(name(p) for p in held)}')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('--worst', type=int, default=6, help='how many hardest moments to print per track')
    args = p.parse_args()
    mid = mido.MidiFile(args.input)
    to_sec = build_tempo_map(mid)
    print(f'{args.input}: {len(mid.tracks)} tracks, {mid.length:.0f}s')
    for i, tr in enumerate(mid.tracks):
        notes = notes_of(tr, mid.ticks_per_beat, to_sec)
        if not notes:
            continue
        print(f'track {i} "{tr.name.strip(chr(0))}"')
        analyze(notes, args.worst)


if __name__ == '__main__':
    main()
