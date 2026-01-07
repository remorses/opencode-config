# Compare Current Branch Against Upstream Default

Compare the current branch against the upstream default branch and view the full diff.

## Step 1: Determine BASE_REF

Run:
```bash
git remote -v
```

If `upstream` remote exists, run:
```bash
DEFAULT_BRANCH=$(gh repo view $(git remote get-url upstream) --json defaultBranchRef --jq '.defaultBranchRef.name') && echo "upstream/$DEFAULT_BRANCH"
```

Otherwise, run:
```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name') && echo "origin/$DEFAULT_BRANCH"
```

Set `BASE_REF` to the output (e.g., `upstream/main`).

## Step 2: Fetch and View Commits

```bash
git fetch ${BASE_REF%%/*} && git log --oneline $BASE_REF...HEAD
```

## Step 3: View Full Diff

```bash
git diff $BASE_REF...HEAD --color=always -U20
```

## Handling Truncated Output

If the diff output is truncated, paginate using `tail -n +N` to skip already-seen lines:

```bash
git diff $BASE_REF...HEAD --color=always -U20 | tail -n +500
```

Replace `500` with the line number where output was truncated. Repeat with increasing values until the full diff is seen:

```bash
git diff $BASE_REF...HEAD --color=always -U20 | tail -n +1000
git diff $BASE_REF...HEAD --color=always -U20 | tail -n +1500
```

Continue until you see the end of the diff.
