"""
Identify a song from an audio file using ShazamIO.

Usage:
    uv run --with shazamio recognize.py /path/to/audio.mp3

Scans the audio at multiple offsets (every 5s) with 15s clips,
because Shazam often fails on intros or quiet sections.
Prints all matches found across the file.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile

from shazamio import Shazam


async def main():
    if len(sys.argv) < 2:
        print("Usage: uv run --with shazamio recognize.py <audio_file>")
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}")
        sys.exit(1)

    # Get duration
    result = subprocess.run(
        ["ffprobe", "-i", audio_path, "-show_entries", "format=duration",
         "-v", "quiet", "-of", "csv=p=0"],
        capture_output=True, text=True,
    )
    duration = float(result.stdout.strip())
    print(f"Audio duration: {duration:.1f}s")

    shazam = Shazam()
    found = []

    with tempfile.TemporaryDirectory() as tmp:
        offsets = list(range(0, int(duration) - 5, 5))
        for offset in offsets:
            clip = os.path.join(tmp, f"clip_{offset}.mp3")
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(offset), "-i", audio_path,
                 "-t", "15", "-acodec", "libmp3lame", "-q:a", "2", clip],
                capture_output=True,
            )

            resp = await shazam.recognize(clip)
            track = resp.get("track", {})
            if track:
                title = track.get("title", "?")
                artist = track.get("subtitle", "?")
                genre = track.get("genres", {}).get("primary", "")
                url = track.get("url", "")
                track_id = track.get("key", "")

                # Skip duplicates
                if track_id not in [f["id"] for f in found]:
                    entry = {
                        "id": track_id,
                        "title": title,
                        "artist": artist,
                        "genre": genre,
                        "url": url,
                        "matched_at_offset": offset,
                    }
                    found.append(entry)
                    print(f"  [{offset}s] MATCH: {artist} - {title} ({genre})")
                    print(f"         {url}")
            else:
                print(f"  [{offset}s] no match")

    print()
    if found:
        print(f"Found {len(found)} song(s):")
        for f in found:
            print(f"  {f['artist']} - {f['title']} ({f['genre']})")
            print(f"  {f['url']}")
    else:
        print("No matches found at any offset.")


asyncio.run(main())
