# /// script
# dependencies = ["osxphotos"]
# ///
"""Search the Apple Photos library by what is in the photo.

Matches every term (AND, case-insensitive substring) against the Photos AI caption,
OCR text (detected_text), labels, places, people, title, description, keywords and filename.

  uv run search.py router sticker
  uv run search.py --from 2026-01-01 --label Document invoice
  uv run search.py --person 'Tommy' --limit 5 --json
"""

import argparse
import json
import os
import sys
from datetime import datetime

import osxphotos

DEFAULT_LIBRARY = os.path.expanduser("~/Pictures/Photos Library default.photoslibrary")


def haystack(photo) -> dict[str, list[str]]:
    info = photo.search_info
    return {
        "caption": [photo.ai_caption or ""],
        "text": list(info.detected_text or []),
        "labels": list(photo.labels or []),
        "place": [photo.place.name] if photo.place and photo.place.name else [],
        "people": list(photo.persons or []),
        "title": [photo.title or "", photo.description or ""],
        "keywords": list(photo.keywords or []),
        "filename": [photo.original_filename or ""],
    }


def matches(fields: dict[str, list[str]], term: str) -> list[str]:
    return [name for name, values in fields.items() if any(term in value.lower() for value in values)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("terms", nargs="*", help="all must match, in any field")
    parser.add_argument("--library", default=DEFAULT_LIBRARY)
    parser.add_argument("--from", dest="from_date", help="YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", help="YYYY-MM-DD")
    parser.add_argument("--label", action="append", default=[], help="exact Photos label, e.g. Document, Screenshot")
    parser.add_argument("--person", action="append", default=[])
    parser.add_argument("--screenshot", action="store_true", help="only screenshots")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    print(f"loading {args.library}", file=sys.stderr)
    photos = osxphotos.PhotosDB(dbfile=args.library).photos()
    print(f"loaded {len(photos)} photos", file=sys.stderr)

    from_date = datetime.fromisoformat(args.from_date).date() if args.from_date else None
    to_date = datetime.fromisoformat(args.to_date).date() if args.to_date else None
    terms = [term.lower() for term in args.terms]
    labels = {label.lower() for label in args.label}
    people = {person.lower() for person in args.person}

    results = []
    for photo in photos:
        day = photo.date.date()
        if (from_date and day < from_date) or (to_date and day > to_date):
            continue
        if args.screenshot and not photo.screenshot:
            continue
        if labels and not labels & {label.lower() for label in photo.labels or []}:
            continue
        if people and not people & {person.lower() for person in photo.persons or []}:
            continue
        fields = haystack(photo)
        hits = [matches(fields, term) for term in terms]
        if not all(hits):
            continue
        results.append((photo, sorted({name for hit in hits for name in hit})))

    results.sort(key=lambda item: item[0].date, reverse=True)
    print(f"{len(results)} matches", file=sys.stderr)
    rows = [
        {
            "uuid": photo.uuid,
            "date": photo.date.isoformat(timespec="minutes"),
            "filename": photo.original_filename,
            "local": not photo.ismissing,
            # Photos' own preview JPEG on disk (largest first): read it directly, no export needed.
            "preview": (photo.path_derivatives or [None])[0],
            "matched": fields,
            "caption": photo.ai_caption,
            "text": (photo.search_info.detected_text or [])[:15],
        }
        for photo, fields in results[: args.limit]
    ]
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return
    for row in rows:
        local = "local" if row["local"] else "icloud"
        print(f"{row['uuid']}  {row['date']}  {row['filename']}  [{local}] matched={','.join(row['matched'])}")
        print(f"    {row['caption'] or ''}")
        if row["preview"]:
            print(f"    preview: {row['preview']}")


if __name__ == "__main__":
    main()
