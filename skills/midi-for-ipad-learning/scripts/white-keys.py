# /// script
# requires-python = ">=3.10"
# dependencies = ["mido"]
# ///
"""Transpose a piano MIDI to C major / A minor, snap leftover black keys to
white keys, split notes into hands, and write full, right hand and left hand files.

uv run white-keys.py song.mid --out "<dir>" --name golden-brown

Hand split: beam search over onset slices (the cost-based approach used in hand
separation and fingering papers, e.g. Nakamura's merged-output HMM, Hadjakos et al.).
Each slice is cut at one pitch: lower notes to the left hand, higher to the right.
Hard limits: 5 notes and a 9th (14 semitones) per hand, counting notes still held.
Soft costs: stretch over an octave, hand jumps, hands crossing, and leaving the
arranger's staff (when the file has 2 tracks, one per staff).
"""

import argparse
from dataclasses import dataclass
from pathlib import Path

import mido

WHITE = {0, 2, 4, 5, 7, 9, 11}
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
PEDALS = {64, 66, 67}

MAX_NOTES = 5
MAX_SPAN = 14  # a 9th: the limit for a normal hand
COMFORT_SPAN = 12
BEAM = 64
IMPOSSIBLE = 1000.0
STRETCH_COST = 4.0  # per semitone over an octave
MOVE_COST = 0.4  # per semitone the hand center moves
CROSS_COST = 30.0
STAFF_COST = 50.0  # per note moved off the arranger's staff: only hard limits beat it
REGISTER_COST = 0.5  # per semitone a note sits on the "wrong" side of middle C (no staff info)
LEFT, RIGHT = 0, 1


@dataclass
class Note:
    start: int
    end: int
    pitch: int
    velocity: int
    staff: int | None  # LEFT / RIGHT from the source track, None if unknown


def corr(a, b):
    ma, mb = sum(a) / 12, sum(b) / 12
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return num / den if den else 0


def read_notes(track, staff):
    notes, open_, t = [], {}, 0
    for msg in track:
        t += msg.time
        if msg.type == 'note_on' and msg.velocity > 0 and msg.channel != 9:
            open_.setdefault((msg.channel, msg.note), []).append(Note(t, t, msg.note, msg.velocity, staff))
        elif msg.type in ('note_on', 'note_off') and open_.get((msg.channel, msg.note)):
            n = open_[(msg.channel, msg.note)].pop(0)
            n.end = max(t, n.start + 1)
            notes.append(n)
    return notes


def slices(notes, tolerance):
    """Group notes that start together (within `tolerance` ticks)."""
    notes = sorted(notes, key=lambda n: (n.start, n.pitch))
    out = []
    for n in notes:
        if out and n.start - out[-1][0].start <= tolerance:
            out[-1].append(n)
        else:
            out.append([n])
    return [sorted(s, key=lambda n: n.pitch) for s in out]


def split_hands(notes, tolerance):
    """Return {id(note): LEFT|RIGHT}."""
    # beam item: (cost, assignment linked list, held notes per hand, last center per hand)
    beam = [(0.0, None, ([], []), (48.0, 72.0))]
    for chord in slices(notes, tolerance):
        t = chord[0].start
        options = [(chord[:k], chord[k:]) for k in range(len(chord) + 1)]
        # the arranger's staves can cross inside one chord; keep that option too
        if all(n.staff is not None for n in chord):
            options.append(tuple([n for n in chord if n.staff == h] for h in (LEFT, RIGHT)))
        candidates = []
        for cost, assign, held, centers in beam:
            still = tuple([n for n in held[h] if n.end > t] for h in (LEFT, RIGHT))
            for parts in options:
                c = cost
                for h in (LEFT, RIGHT):
                    struck = parts[h]
                    pitches = [n.pitch for n in struck + still[h]]
                    if not pitches:
                        continue
                    span = max(pitches) - min(pitches)
                    if len(pitches) > MAX_NOTES or span > MAX_SPAN:
                        c += IMPOSSIBLE
                    c += max(0, span - COMFORT_SPAN) * STRETCH_COST
                    if struck:
                        center = sum(n.pitch for n in struck) / len(struck)
                        c += abs(center - centers[h]) * MOVE_COST
                    for n in struck:
                        if n.staff is not None:
                            c += STAFF_COST * (n.staff != h)
                        else:
                            c += REGISTER_COST * (max(0, n.pitch - 64) if h == LEFT else max(0, 57 - n.pitch))
                lh = [n.pitch for n in parts[LEFT] + still[LEFT]]
                rh = [n.pitch for n in parts[RIGHT] + still[RIGHT]]
                if lh and rh and min(rh) < max(lh):
                    c += CROSS_COST
                new_centers = tuple(
                    sum(n.pitch for n in parts[h]) / len(parts[h]) if parts[h] else centers[h] for h in (LEFT, RIGHT)
                )
                candidates.append((c, assign, still, parts, new_centers))
        candidates.sort(key=lambda x: x[0])
        # Viterbi-style: keep only the cheapest path per held-notes state, so the beam
        # holds different hand states instead of many copies of the same one
        beam, seen = [], set()
        for c, assign, still, parts, centers in candidates:
            held = (still[LEFT] + parts[LEFT], still[RIGHT] + parts[RIGHT])
            state = tuple(frozenset(id(n) for n in held[h]) for h in (LEFT, RIGHT))
            if state in seen:
                continue
            seen.add(state)
            beam.append((c, (assign, parts), held, centers))
            if len(beam) == BEAM:
                break
    # assignment is a linked list (previous, parts) back to the first slice
    hands, node = {}, beam[0][1]
    while node:
        node, parts = node
        for h in (LEFT, RIGHT):
            for n in parts[h]:
                hands[id(n)] = h
    return hands


def snap(pitch):
    # black key -> white key one semitone down (G# -> G, Bb -> A)
    return pitch - 1 if pitch % 12 not in WHITE else pitch


def build_track(name, channel, notes, pedals):
    """Notes -> mido track. Overlapping notes of the same pitch are merged."""
    events = [(0, 0, mido.MetaMessage('track_name', name=name)), (0, 0, mido.Message('program_change', channel=channel, program=0))]
    for n in notes:
        events.append((n.start, 2, mido.Message('note_on', channel=channel, note=n.pitch, velocity=n.velocity)))
        events.append((n.end, 1, mido.Message('note_off', channel=channel, note=n.pitch, velocity=0)))
    for t, msg in pedals:
        events.append((t, 1, msg.copy(channel=channel)))
    events.sort(key=lambda e: (e[0], e[1]))  # offs before ons at the same tick
    track, last, active = mido.MidiTrack(), 0, {}
    for t, _, msg in events:
        if msg.type in ('note_on', 'note_off'):
            on = msg.type == 'note_on'
            count = active.get(msg.note, 0)
            active[msg.note] = count + (1 if on else -1)
            if (on and count > 0) or (not on and count != 1):
                continue
        track.append(msg.copy(time=t - last))
        last = t
    track.append(mido.MetaMessage('end_of_track', time=0))
    return track


def main():
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('--out', required=True, help='output folder')
    p.add_argument('--name', required=True, help='file prefix, e.g. golden-brown')
    p.add_argument('--tracks', help='comma separated track indexes to use (default: all non drum note tracks)')
    p.add_argument('--shift', type=int, help='force transpose semitones instead of auto')
    p.add_argument('--no-snap', action='store_true', help='keep black keys after transposing')
    p.add_argument('--ignore-staves', action='store_true', help='split by playability only, ignore the 2 source tracks')
    args = p.parse_args()

    src = mido.MidiFile(args.input)
    print(f'source: {args.input} ({len(src.tracks)} tracks, {src.length:.0f}s)')

    per_track = {i: read_notes(t, None) for i, t in enumerate(src.tracks)}
    idx = [int(x) for x in args.tracks.split(',')] if args.tracks else [i for i, n in per_track.items() if n]
    for i in idx:
        ps = [n.pitch for n in per_track[i]]
        print(f'  track {i} "{src.tracks[i].name.strip(chr(0))}": {len(ps)} notes, avg pitch {sum(ps) / len(ps):.0f}')

    if len(idx) == 2 and not args.ignore_staves:
        avg = lambda i: sum(n.pitch for n in per_track[i]) / len(per_track[i])
        low, high = sorted(idx, key=avg)
        for n in per_track[low]:
            n.staff = LEFT
        for n in per_track[high]:
            n.staff = RIGHT
        print(f'staves: right = track {high}, left = track {low}')
    notes = [n for i in idx for n in per_track[i]]

    # transpose: shift with most (duration weighted) notes on white keys
    hist = [0.0] * 12
    for n in notes:
        hist[n.pitch % 12] += n.end - n.start
    total = sum(hist)

    def white_ratio(s):
        return sum(w for pc, w in enumerate(hist) if (pc + s) % 12 in WHITE) / total

    shift = args.shift if args.shift is not None else max(range(-6, 6), key=lambda s: (white_ratio(s), -abs(s)))
    shifted = [hist[(pc - shift) % 12] for pc in range(12)]
    # A minor profile: value at pitch class p is MINOR[(p - 9) % 12]
    key = 'Am' if corr(shifted, MINOR[3:] + MINOR[:3]) > corr(shifted, MAJOR) else 'C'
    print(f'transpose: {shift:+d} semitones -> {key}, white keys before snap: {white_ratio(shift):.1%}')

    snapped = 0
    for n in notes:
        n.pitch = max(0, min(127, n.pitch + shift))
        if not args.no_snap and n.pitch % 12 not in WHITE:
            n.pitch = snap(n.pitch)
            snapped += 1
    if not args.no_snap:
        print(f'snapped black keys to white: {snapped} of {len(notes)} notes')

    hands = split_hands(notes, tolerance=src.ticks_per_beat // 32)
    moved = sum(1 for n in notes if n.staff is not None and hands[id(n)] != n.staff)
    rh = [n for n in notes if hands[id(n)] == RIGHT]
    lh = [n for n in notes if hands[id(n)] == LEFT]
    print(f'hands: right {len(rh)} notes, left {len(lh)} notes, {moved} notes moved off their staff')

    meta, pedals = [], []
    for i, tr in enumerate(src.tracks):
        t = 0
        for msg in tr:
            t += msg.time
            if msg.is_meta and msg.type in ('set_tempo', 'time_signature'):
                meta.append((t, msg))
            elif i in idx and msg.type == 'control_change' and msg.control in PEDALS:
                pedals.append((t, msg))
    meta.sort(key=lambda e: e[0])

    def conductor():
        tr, last = mido.MidiTrack([mido.MetaMessage('key_signature', key=key, time=0)]), 0
        for t, m in meta:
            tr.append(m.copy(time=t - last))
            last = t
        tr.append(mido.MetaMessage('end_of_track', time=0))
        return tr

    rh_track = build_track('Right Hand', 0, rh, pedals)
    lh_track = build_track('Left Hand', 1, lh, pedals)
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    for suffix, parts in [('full', [rh_track, lh_track]), ('right-hand', [rh_track]), ('left-hand', [lh_track])]:
        f = mido.MidiFile(type=1, ticks_per_beat=src.ticks_per_beat)
        f.tracks = [conductor(), *parts]
        path = out / f'{args.name}-{suffix}.mid'
        f.save(path)
        print(f'wrote {path}')


if __name__ == '__main__':
    main()
