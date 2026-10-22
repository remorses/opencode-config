# /// script
# requires-python = ">=3.10"
# dependencies = ["mido"]
# ///
"""Transpose a piano MIDI to C major / A minor and snap leftover black keys to
white keys. Tracks, tempo, time signatures and pedal are kept.

uv run white-keys.py song.mid --out song-white.mid
"""

import argparse

import mido

WHITE = {0, 2, 4, 5, 7, 9, 11}
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def corr(a, b):
    ma, mb = sum(a) / 12, sum(b) / 12
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return num / den if den else 0


def is_on(msg):
    return msg.type == 'note_on' and msg.velocity > 0


def is_off(msg):
    return msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0)


def histogram(mid):
    """Duration-weighted pitch class histogram, drums excluded."""
    hist = [0.0] * 12
    for track in mid.tracks:
        t, start = 0, {}
        for msg in track:
            t += msg.time
            if is_on(msg) and msg.channel != 9:
                start.setdefault((msg.channel, msg.note), t)
            elif is_off(msg) and (msg.channel, msg.note) in start:
                hist[msg.note % 12] += max(t - start.pop((msg.channel, msg.note)), 1)
    return hist


def transpose_track(track, shift, snap, key):
    """Returns (new track, snapped count). Notes that collide after snapping are merged."""
    events, t = [], 0
    for msg in track:
        t += msg.time
        events.append((t, msg))
    out, active, snapped = [], {}, 0
    if key:
        out.append((0, mido.MetaMessage('key_signature', key=key)))
    for t, msg in events:
        if msg.type == 'key_signature':
            continue
        if msg.type in ('note_on', 'note_off') and msg.channel != 9:
            note = max(0, min(127, msg.note + shift))
            if snap and note % 12 not in WHITE:
                note -= 1  # G# -> G, Bb -> A
                snapped += is_on(msg)
            k = (msg.channel, note)
            count = active.get(k, 0)
            if is_on(msg):
                active[k] = count + 1
                if count:
                    continue
            else:
                if count == 0:
                    continue
                active[k] = count - 1
                if count > 1:
                    continue
            msg = msg.copy(note=note)
        out.append((t, msg))
    new, last = mido.MidiTrack(), 0
    for t, msg in out:
        new.append(msg.copy(time=t - last))
        last = t
    return new, snapped


def main():
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('--out', required=True, help='output .mid path')
    p.add_argument('--shift', type=int, help='force transpose semitones instead of auto')
    p.add_argument('--no-snap', action='store_true', help='keep black keys after transposing')
    args = p.parse_args()

    src = mido.MidiFile(args.input)
    hist = histogram(src)
    total = sum(hist)

    def white_ratio(s):
        return sum(w for pc, w in enumerate(hist) if (pc + s) % 12 in WHITE) / total

    # shift with most (duration weighted) notes on white keys = C major / A minor
    shift = args.shift if args.shift is not None else max(range(-6, 6), key=lambda s: (white_ratio(s), -abs(s)))
    shifted = [hist[(pc - shift) % 12] for pc in range(12)]
    # A minor profile: value at pitch class p is MINOR[(p - 9) % 12]
    key = 'Am' if corr(shifted, MINOR[3:] + MINOR[:3]) > corr(shifted, MAJOR) else 'C'
    print(f'transpose: {shift:+d} semitones -> {key}, white keys before snap: {white_ratio(shift):.1%}')

    out = mido.MidiFile(type=src.type, ticks_per_beat=src.ticks_per_beat)
    snapped = 0
    for i, track in enumerate(src.tracks):
        new, n = transpose_track(track, shift, not args.no_snap, key if i == 0 else None)
        out.tracks.append(new)
        snapped += n
    out.save(args.out)
    total_notes = sum(1 for tr in src.tracks for m in tr if is_on(m))
    print(f'snapped black keys to white: {snapped} of {total_notes} notes')
    print(f'wrote {args.out}')


if __name__ == '__main__':
    main()
