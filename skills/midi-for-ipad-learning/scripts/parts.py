# /// script
# requires-python = ">=3.10"
# dependencies = ["mido"]
# ///
"""Show a MIDI as text bar by bar, find repeated bars, and cut it into parts.

uv run parts.py show song.mid                     # bar labels + repeat summary + notes per bar
uv run parts.py show song.mid --from 9 --to 16    # only some bars
uv run parts.py cut song.mid --out <dir> --name golden-brown \
  --part riff:1-6 --part verse:13-20

Bars come from the MIDI time signatures (6/8, 7/8 changes work). Similar bars share
a letter; `~` marks a small variation (up to 2 notes, or 20% of the notes, differ).
`cut` writes one file per unique part and skips parts that repeat an earlier one.
"""

import argparse
import re
from dataclasses import dataclass
from pathlib import Path

import mido

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
PEDALS = {64, 66, 67}
MAX_LOOP_BARS = 8
SMALL_DIFF_NOTES = 2
SMALL_DIFF_RATIO = 0.2


@dataclass
class Note:
    start: int
    end: int
    pitch: int
    track: int


@dataclass
class Bar:
    number: int
    start: int
    end: int
    numerator: int
    denominator: int
    notes: list
    label: str = ''
    exact: bool = True


def note_name(p):
    return f'{NAMES[p % 12]}{p // 12 - 1}'


def absolute(track):
    t = 0
    for msg in track:
        t += msg.time
        yield t, msg


def read_notes(mid):
    notes = []
    for i, track in enumerate(mid.tracks):
        open_ = {}
        for t, msg in absolute(track):
            if msg.type == 'note_on' and msg.velocity > 0 and msg.channel != 9:
                open_.setdefault((msg.channel, msg.note), []).append(t)
            elif msg.type in ('note_on', 'note_off') and open_.get((msg.channel, msg.note)):
                notes.append(Note(open_[(msg.channel, msg.note)].pop(0), t, msg.note, i))
    return sorted(notes, key=lambda n: (n.start, n.pitch))


def meta_events(mid):
    events = [(t, m) for tr in mid.tracks for t, m in absolute(tr) if m.type in ('time_signature', 'set_tempo', 'key_signature')]
    return sorted(events, key=lambda e: e[0])


def seconds_at(mid):
    tempos = [(t, m.tempo) for t, m in meta_events(mid) if m.type == 'set_tempo'] or [(0, 500000)]
    if tempos[0][0] > 0:
        tempos.insert(0, (0, 500000))

    def to_sec(tick):
        sec, prev_t, prev_tempo = 0.0, 0, tempos[0][1]
        for t, tempo in tempos:
            if t >= tick:
                break
            sec += mido.tick2second(t - prev_t, mid.ticks_per_beat, prev_tempo)
            prev_t, prev_tempo = t, tempo
        return sec + mido.tick2second(tick - prev_t, mid.ticks_per_beat, prev_tempo)

    return to_sec


def read_bars(mid):
    notes = read_notes(mid)
    end = max(n.end for n in notes)
    sigs = [(t, m.numerator, m.denominator) for t, m in meta_events(mid) if m.type == 'time_signature'] or [(0, 4, 4)]
    bars, t, num, den, i = [], 0, sigs[0][1], sigs[0][2], 0
    while t < end:
        while i < len(sigs) and sigs[i][0] <= t:
            _, num, den = sigs[i]
            i += 1
        length = mid.ticks_per_beat * 4 * num // den
        bar_end = t + length
        # a time signature change inside this bar ends it early
        if i < len(sigs) and sigs[i][0] < bar_end:
            bar_end = sigs[i][0]
        bars.append(Bar(len(bars) + 1, t, bar_end, num, den, [n for n in notes if t <= n.start < bar_end]))
        t = bar_end
    return bars


def fingerprint(bar, tpb):
    step = tpb // 4  # 16th note grid
    return {(round((n.start - bar.start) / step), n.pitch) for n in bar.notes}


def label_bars(bars, tpb):
    reps = []  # (label, fingerprint, length)
    for bar in bars:
        fp = fingerprint(bar, tpb)
        if not fp:
            bar.label = '-'
            continue
        length = bar.end - bar.start
        for label, rep, rep_len in reps:
            if rep_len != length:
                continue
            diff = len(fp ^ rep)
            if diff <= max(SMALL_DIFF_NOTES, SMALL_DIFF_RATIO * max(len(fp), len(rep))):
                bar.label, bar.exact = label, diff == 0
                break
        else:
            letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
            label = letters[len(reps)] if len(reps) < len(letters) else f'#{len(reps)}'
            reps.append((label, fp, length))
            bar.label = label


def summarize(bars):
    """Group bars into runs: a unit of 1-8 bars repeated k times, or single bars."""
    labels = [b.label for b in bars]
    out, i = [], 0
    while i < len(labels):
        best = (1, 1)  # (unit length, repeats)
        for size in range(1, MAX_LOOP_BARS + 1):
            unit = labels[i:i + size]
            if len(unit) < size:
                break
            k = 1
            while labels[i + k * size:i + (k + 1) * size] == unit:
                k += 1
            if k >= 2 and size * k > best[0] * best[1]:
                best = (size, k)
        size, k = best
        out.append((i, size, k))
        i += size * k
    return out


def print_phrases(bars, size, offset, to_sec):
    """Group bars in phrases of `size` bars. Same bar letters = same phrase number;
    `(~P2)` marks a new phrase where only 1 bar differs from P2."""
    print(f'phrases ({size} bars, starting at bar {offset + 1}):')
    reps = []
    if offset:
        print(f'  bars   1-{offset:<3d} {fmt_time(0)}  pickup  ' + ' '.join(b.label for b in bars[:offset]))
    for i in range(offset, len(bars), size):
        chunk = bars[i:i + size]
        labels = [b.label for b in chunk]
        diffs = [sum(a != b for a, b in zip(rep, labels)) if len(rep) == len(labels) else size for rep in reps]
        if 0 in diffs:
            num, near = diffs.index(0) + 1, ''
        else:
            reps.append(labels)
            num = len(reps)
            near = f'(~P{diffs.index(1) + 1})' if 1 in diffs else ''
        bar_labels = ' '.join(b.label + ('' if b.exact else '~') for b in chunk)
        print(f'  bars {chunk[0].number:3d}-{chunk[-1].number:<3d} {fmt_time(to_sec(chunk[0].start))}  P{num:<2d} {bar_labels} {near}')


def fmt_time(sec):
    return f'{int(sec // 60)}:{sec % 60:04.1f}'


def show(args):
    mid = mido.MidiFile(args.input)
    bars = read_bars(mid)
    label_bars(bars, mid.ticks_per_beat)
    to_sec = seconds_at(mid)
    print(f'{args.input}: {len(bars)} bars, {mid.length:.0f}s')
    print('labels: ' + ' '.join(b.label + ('' if b.exact else '~') for b in bars))
    print('runs (unit x repeats, bars that do not repeat are grouped):')
    singles = []

    def flush():
        if singles:
            print(f'  bars {singles[0].number:3d}-{singles[-1].number:<3d} {fmt_time(to_sec(singles[0].start))}  ' + ' '.join(x.label for x in singles))
            singles.clear()

    for i, size, k in summarize(bars):
        if k == 1:
            singles.extend(bars[i:i + size])
            continue
        flush()
        a, b = bars[i], bars[i + size * k - 1]
        unit = ' '.join(x.label for x in bars[i:i + size])
        print(f'  bars {a.number:3d}-{b.number:<3d} {fmt_time(to_sec(a.start))}  ({unit}) x{k}')
    flush()
    if args.phrase:
        print_phrases(bars, args.phrase, args.offset, to_sec)
    if args.no_notes:
        return
    print('notes (beat: pitches, beat unit = time signature denominator, lower track first):')
    for bar in bars:
        if bar.number < args.start or bar.number > args.stop:
            continue
        unit = mid.ticks_per_beat * 4 / bar.denominator
        onsets = {}
        for n in bar.notes:
            onsets.setdefault(n.start, []).append(n)
        cells = []
        for t in sorted(onsets):
            beat = 1 + (t - bar.start) / unit
            ns = sorted(onsets[t], key=lambda n: (-n.track, n.pitch))
            cells.append(f'{beat:g}:' + '.'.join(note_name(n.pitch) for n in ns))
        tag = bar.label + ('' if bar.exact else '~')
        print(f'  {bar.number:3d} {tag:3s} {bar.numerator}/{bar.denominator} {fmt_time(to_sec(bar.start))} | ' + ' '.join(cells))


def cut_range(mid, start, end):
    """New MidiFile with everything in [start, end) moved to time 0."""
    meta = meta_events(mid)
    out = mido.MidiFile(type=1, ticks_per_beat=mid.ticks_per_beat)
    for i, track in enumerate(mid.tracks):
        events = []
        if i == 0:
            # tempo, time and key signature in force at the cut start
            last = {}
            for t, m in meta:
                if t <= start:
                    last[m.type] = m
            events += [(0, m) for m in last.values()]
        before = {}
        open_ = {}
        for t, msg in absolute(track):
            if msg.type == 'end_of_track':
                continue
            if t < start:
                if msg.type == 'program_change' or (msg.type == 'control_change' and msg.control in PEDALS):
                    before[(msg.type, getattr(msg, 'control', None), msg.channel)] = msg
                continue
            if t >= end:
                continue  # notes still open are closed at the cut end below
            if msg.is_meta:
                if i == 0 and msg.type in ('set_tempo', 'time_signature', 'key_signature') and t > start:
                    events.append((t - start, msg))
                continue
            if msg.type == 'note_on' and msg.velocity > 0:
                open_[(msg.channel, msg.note)] = open_.get((msg.channel, msg.note), 0) + 1
            elif msg.type in ('note_on', 'note_off'):
                if not open_.get((msg.channel, msg.note)):
                    continue  # note started before the cut
                open_[(msg.channel, msg.note)] -= 1
            events.append((t - start, msg))
        events[:0] = [(0, m) for m in before.values()]
        for (ch, note), count in open_.items():
            events += [(end - start, mido.Message('note_off', channel=ch, note=note, velocity=0))] * count
        for (kind, control, ch) in before:
            if kind == 'control_change':
                events.append((end - start, mido.Message('control_change', channel=ch, control=control, value=0)))
        events.sort(key=lambda e: e[0])
        new, last_t = mido.MidiTrack(), 0
        for t, msg in events:
            new.append(msg.copy(time=t - last_t))
            last_t = t
        new.append(mido.MetaMessage('end_of_track', time=0))
        out.tracks.append(new)
    return out


def cut(args):
    mid = mido.MidiFile(args.input)
    bars = read_bars(mid)
    label_bars(bars, mid.ticks_per_beat)
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    written = {}  # bar label sequence -> file name
    n = 0
    for spec in args.part:
        m = re.fullmatch(r'([\w-]+):(\d+)-(\d+)', spec)
        if not m:
            raise SystemExit(f'bad --part {spec!r}, use name:from-to')
        name, a, b = m[1], int(m[2]), int(m[3])
        sel = bars[a - 1:b]
        key = tuple(x.label for x in sel)
        if key in written:
            print(f'skip {name} bars {a}-{b}: same as {written[key]}')
            continue
        n += 1
        path = out_dir / f'{args.name}-{n:02d}-{name}-bars-{a}-{b}.mid'
        cut_range(mid, sel[0].start, sel[-1].end).save(path)
        written[key] = path.name
        print(f'wrote {path} (bars {a}-{b}: {" ".join(key)})')


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('show')
    s.add_argument('input')
    s.add_argument('--from', dest='start', type=int, default=1)
    s.add_argument('--to', dest='stop', type=int, default=10**9)
    s.add_argument('--no-notes', action='store_true', help='only labels and runs')
    s.add_argument('--phrase', type=int, help='also group bars in phrases of N bars (4 or 8 is common)')
    s.add_argument('--offset', type=int, default=0, help='bars before the first phrase (pickup or intro)')
    c = sub.add_parser('cut')
    c.add_argument('input')
    c.add_argument('--out', required=True, help='output folder')
    c.add_argument('--name', required=True, help='file prefix, e.g. golden-brown')
    c.add_argument('--part', action='append', required=True, help='name:from-to (bar numbers, inclusive)')
    args = p.parse_args()
    show(args) if args.cmd == 'show' else cut(args)


if __name__ == '__main__':
    main()
