---
description: Commit, update changelog, npm publish
agent: build
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
2. Update or create `CHANGELOG.md` with bullet points under the new version heading. use rich markdown formatting. code snippets, diagrams. make it pleasant to read.

### Merging Unreleased Versions

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

**Do NOT use `--notes-file CHANGELOG.md`** - that dumps the entire changelog (all versions) into the release body.

Instead, manually extract only the current version's section from CHANGELOG.md and pass it via `--notes` with a heredoc:

```bash
gh release create packagename@x.y.z --title "packagename@x.y.z" --notes "$(cat <<'EOF'
<paste only the current version's changelog section here>
EOF
)" --latest
```

Include external contributors in the release notes: "thanks @username for the contribution"

**Submodule packages:** Run `gh release` from inside the submodule directory.

## Step 8: Handle Publish Failures

If publish fails due to TypeScript errors or other issues, fix them and retry.

## Output

After publishing, report what you did and include the GitHub release link.
