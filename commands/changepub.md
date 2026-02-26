---
description: Commit, update changelog, npm publish
# agent: build
subtask: false
model: anthropic/claude-sonnet-4-6
---

# Publishing npm Packages

## Step 1: Understand Current Changes

Read the diff and commit history since the last release:

```bash
git diff HEAD
git log packagename@0.4.55..HEAD --oneline
```

Replace `packagename@0.4.55` with the actual last published tag.

## Step 2: Determine What Needs Publishing

Check the last published version:

```bash
npm show packagename version
```

For monorepos, check each workspace package to identify which ones have unpublished changes.

## Step 3: Bump Version and Update Changelog

1. Bump the version in `package.json` (never do major bumps)
2. Update or create `CHANGELOG.md` with a **numbered list** under the new version heading

### Changelog format

Use numbered lists, not bullets. Each item describes a **user-facing outcome**:

```md
## 0.5.0

1. **Added `--dry-run` flag** — preview publish without uploading
2. **Fixed timeout on large uploads** — uploads over 50MB no longer hang
3. **Changed default retry count from 3 to 5** — improves reliability on flaky networks
```

Include code snippets when they help users understand the change:

```md
3. **New `onProgress` callback** — track upload progress:
   ```ts
   await upload(file, {
     onProgress: (pct) => console.log(`${pct}% done`)
   })
   ```
```

### What NOT to include

Exclude anything users don't directly experience:

- "added tests for X" — internal quality, not user-facing
- "improved test flakiness" — CI stability, users don't see this
- "refactored internals" — no behavior change
- "updated CI config" — internal tooling
- "bumped dev dependencies" — doesn't affect published package

**Transform internal work into user-facing impact when relevant:**

- bad: "fixed race condition in retry logic"
- good: "fixed intermittent upload failures under high concurrency"

### Merging unreleased versions

If multiple versions accumulated since last publish, merge them into one changelog entry. Only describe the final state:
- If a feature was added then removed, don't mention it
- If a feature was added then bug-fixed, just mention the added feature

## Step 4: Commit the Release

```bash
git add .
git commit -m "release: packagename@x.y.z"
```

## Step 5: Publish to npm

Use the correct package manager based on the lockfile:
- `pnpm-lock.yaml` → `pnpm publish`
- `bun.lock` or `bun.lockb` → `bun publish`
- `package-lock.json` → `npm publish` (last resort)

Using the wrong package manager leaves workspace references unresolved and breaks the published package.

**After publishing**, regenerate the lockfile:

```bash
pnpm i  # or bun i
```

This updates the lockfile with the new version so workspace references resolve correctly.

### Monorepo Publishing Order

Publish packages in topological order (dependencies first). Always publish dependencies if they have changes.

## Step 6: Tag and Push

```bash
git tag packagename@x.y.z
git push origin HEAD --tags
```

## Step 7: Create GitHub Release

**Never create draft releases** — always publish releases immediately so users see them.

**Do NOT use `--notes-file CHANGELOG.md`** — that dumps the entire changelog into the release body.

Extract only the current version's section and pass via `--notes`:

```bash
gh release create packagename@x.y.z --title "packagename@x.y.z" --notes "$(cat <<'EOF'
1. **Added `--dry-run` flag** — preview publish without uploading
2. **Fixed timeout on large uploads** — uploads over 50MB no longer hang
3. **Changed default retry count from 3 to 5** — improves reliability on flaky networks

Thanks @contributor for #42!
EOF
)" --latest
```

### Release notes decision flow

```
┌─────────────────────────────────────┐
│  For each commit/PR since last tag  │
└──────────────┬──────────────────────┘
               │
               v
       ┌───────────────┐
       │ User notices  │──no──> exclude
       │ this change?  │
       └───────┬───────┘
               │ yes
               v
       ┌───────────────┐
       │ Behavior or   │──behavior──> describe what changed
       │ new feature?  │
       └───────┬───────┘
               │ feature
               v
         describe what users
         can now do + example
```

### What belongs in release notes

- **New flags/options** — "Added `--format json` for machine-readable output"
- **Bug fixes users hit** — "Fixed crash when config file missing"
- **Behavior changes** — "Default timeout increased from 30s to 60s"
- **Breaking changes** — "Renamed `--old` to `--new` — update your scripts"
- **Performance users feel** — "Startup time reduced from 2s to 200ms"

### What does NOT belong

- "Added unit tests" / "Improved test coverage"
- "Refactored X module" (no behavior change)
- "Fixed CI flakiness" / "Updated GitHub Actions"
- "Bumped internal dependencies"

Include external contributors: "Thanks @username for #42!"

**Submodule packages:** Run `gh release` from inside the submodule directory.

## Step 8: Handle Publish Failures

If publish fails due to TypeScript errors or other issues, fix them and retry.

## Output

After publishing, report what you did and include the GitHub release link.

also make sure that we always use `workspace:^` instead of `workspace:*` for workspace dependencies in package.json. using :* will use the pinned package in released npm package.json files, instead of ^.
