---
name: shift-commits
description: >
  Rewrite git commit timestamps to shift weekday before-5PM commits to after 5 PM.
  Use when the user wants to shift, rewrite, or adjust commit times so they appear
  to be made after working hours. Supports dry-run preview, date range filtering,
  and deterministic per-commit hour assignment.
---

# shift-commits

Rewrites git history so weekday commits made before 5 PM get shifted to 17:00-22:00.
Weekend and already-after-5PM commits are left untouched.

Run the CLI from inside any git repository:

```bash
# Preview what would change (no modifications)
bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --dry-run

# Shift commits from a specific date onward
bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06

# Actually rewrite history
bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06 --run

# Custom hour range (default 17-22)
bun ~/.config/opencode/skills/shift-commits/shift-commits.ts --after 2026-07-06 --min-hour 18 --max-hour 23 --run
```

After rewriting, verify with `git log` and force push with `git push --force`.

A backup ref is saved automatically so you can recover with `git reset --hard` to the backup ref if anything goes wrong.

## How it works

- Each commit gets a deterministic new hour based on its SHA hash (first 8 hex chars mod hour range). Same hash always produces the same hour.
- Original minutes and seconds are preserved for natural variation.
- Both author and committer dates are shifted by the same delta.
- Original timezone offsets are preserved.
- `git filter-branch --env-filter` handles the rewrite.

## Important

- This rewrites history. Every commit from the start date onward gets a new SHA.
- You must force push afterward.
- Open PRs referencing old SHAs will break.
- Always use `--dry-run` first to preview changes.
