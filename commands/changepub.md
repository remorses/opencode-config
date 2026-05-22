---
description: Commit, update changelog, npm publish
# agent: build
subtask: false
# model: anthropic/claude-sonnet-4-6
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

**Compare the npm version against `package.json`.** If `package.json` is already ahead (e.g. npm has 0.0.89 but package.json says 0.0.101), those intermediate versions were never published. The changelog and GitHub release MUST cover everything since the last **published** npm version, not just the latest changelog section.

Use the npm version (not the package.json version) as the baseline for:
- `git log` to find all commits that need covering
- changelog content to include in GitHub release notes
- determining what features are "new" to users

For monorepos, check each workspace package to identify which ones have unpublished changes.

## Step 3: Bump Version and Update Changelog

1. Bump the version in `package.json` (never do major bumps)
2. Update or create `CHANGELOG.md` with a **numbered list** under the new version heading

### Semver bump rules

- **minor** when users get a **new feature, new command, new flag, new option, or new capability**
- **patch** only when the release is **only fixes, small behavior adjustments, or performance improvements**
- Never default to patch when there are new user-facing features

Examples:

- new `build --watch` command → **minor**
- new `--format json` option → **minor**
- support for a new config field or API callback → **minor**
- fix crash on invalid config with no new capability → **patch**
- faster startup with no new behavior → **patch**

### Changelog format

Use numbered lists, not bullets. Each item describes a **user-facing outcome**.

**Always sort by relevancy:**

1. **Big new features** — user-facing capabilities that change what users can do
2. **New CLI commands/options** — always with usage examples
3. **Behavior changes** — things users will notice
4. **Bug fixes** — issues users hit
5. **Performance improvements** — only if users feel the difference

````md
## 0.5.0

1. **New streaming upload mode** — upload large files without loading them into memory:
   ```bash
   mycli upload --stream ./huge-file.zip
   ```
````

Supports files up to 100GB. Progress is shown in real-time.

2. **Added `--dry-run` flag** — preview publish without uploading:

   ```bash
   mycli publish --dry-run
   ```

3. **Fixed timeout on large uploads** — uploads over 50MB no longer hang
4. **Changed default retry count from 3 to 5** — improves reliability on flaky networks

````

### Research commits for context

Before writing changelog entries for new features, read the documentation and markdown files that were updated in the commits:

```bash
# Find docs updated alongside the feature
git show <commit> --stat | grep -E '\.(md|mdx)$'

# Read the actual doc changes
git show <commit> -- docs/
````

This gives you the full context: examples, diagrams, and explanations the author wrote. Use this to write rich changelog entries that help users understand the feature.

If a feature ships in this release, the version bump should usually be **minor**, not patch.

### CLI commands and options

**Always include usage examples for new CLI flags, commands, or options:**

````md
3. **New `--format` option** — output results in different formats:

   ```bash
   # JSON for scripting
   mycli list --format json | jq '.items[]'

   # Table for humans
   mycli list --format table
   ```
````

````

Show real-world use cases, not just the flag name. If a flag interacts with others, show the combination.

### Big features deserve depth

For significant new capabilities, go beyond one-liners:

- Explain **what users can now do** that they couldn't before
- Include **code examples** showing typical usage
- Add **ASCII diagrams** if they clarify architecture or flow
- Mention **limitations or caveats** users should know
- Link to docs if available

```md
1. **New plugin system** — extend functionality with custom plugins:

   Plugins can hook into the upload lifecycle:
   ```ts
   export default {
     beforeUpload(file) {
       console.log(`Uploading ${file.name}`)
     },
     afterUpload(result) {
       notify(`Done: ${result.url}`)
     }
   }
````

Load plugins via config or CLI:

```bash
mycli upload --plugin ./my-plugin.ts
```

See [Plugin Guide](./docs/plugins.md) for the full API.

````

### Code snippets

Include code snippets when they help users understand the change:

```md
3. **New `onProgress` callback** — track upload progress:
   ```ts
   await upload(file, {
     onProgress: (pct) => console.log(`${pct}% done`)
   })
````

````

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

### Verify examples against source code

Before committing the changelog, **read the actual source code, README, and docs** to verify every example is accurate. Never guess or hallucinate identifiers like model IDs, flag names, command names, enum values, or API endpoints.

Specifically:

1. **Read the README** — check that CLI examples, flag names, and option values match what the README documents
2. **Read relevant source files** — for CLIs, read the command definitions to verify flag names and accepted values. For libraries, read the public API surface to verify function signatures, parameter names, and types
3. **Run help commands** — if the tool has a `--help` flag or a `models`/`list` command, run it to get the real identifiers instead of inventing them
4. **Cross-check every code snippet** — every model ID, flag name, enum value, URL, and command in the changelog must exist in the source. If you're not sure, grep for it

```bash
# Example: verify CLI flags exist
node bin.js --help
node bin.js <subcommand> --help

# Example: verify model/enum IDs
grep -r 'some-model-id' src/

# Example: check README examples match
cat README.md | grep -A5 'some-feature'
```

This prevents publishing changelogs and release notes with wrong identifiers that confuse users.

## Step 4: Commit the Release

If any changeset `.md` files reference GitHub issues with `Fixes #123`, `Closes #456`, or similar keywords, include those references in the commit message body. GitHub closes issues automatically when the commit containing these keywords lands on the default branch.

```bash
git add .
git commit -m 'release: packagename@x.y.z

Fixes #123
Closes #456'
```

Collect all issue references from the changeset files being consumed and append them as separate lines in the commit body. This ensures issues get closed at publish time without needing a separate PR or GitHub Action.

## Step 5: Publish to npm

**NEVER use `npm publish` if the project uses pnpm or bun.** `npm` does not understand `workspace:^` references and will publish them as literal strings, breaking the package for every consumer. This is not a theoretical risk; it has caused broken releases.

Detect the package manager from the lockfile and use ONLY that tool:

- `pnpm-lock.yaml` → `pnpm publish` (NEVER `npm publish`)
- `bun.lock` or `bun.lockb` → `bun publish` (NEVER `npm publish`)
- `package-lock.json` → `npm publish` (only valid option)

Run publish from **inside the package directory** (use `workdir` in bash tool, NOT `--dir` or `--filter`). `pnpm publish` does not support `--dir`. Do NOT run from the monorepo root.

```bash
# pnpm — cd into the package folder first, then publish
# CORRECT:
cd vite && pnpm publish --access public --no-git-checks

# WRONG — these do NOT work:
# pnpm --dir vite publish        ← npm parses flags wrong
# pnpm publish --dir vite        ← --dir is not a publish flag
# pnpm --filter @pkg/name publish ← does not resolve workspace refs

# bun project — also from inside the package folder
bun publish --access public
```

After publishing, immediately verify no `workspace:` references leaked:

```bash
npm view packagename@x.y.z dependencies --json | grep workspace
# must return empty — if it returns anything, the publish is broken
```

If a broken version was published, bump patch, republish correctly, and deprecate the broken version:

```bash
npm deprecate 'packagename@x.y.z' 'Broken: unresolved workspace references. Use x.y.z+1 instead.'
```

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

**NEVER pass `--prerelease` to `gh release create`**, even for prerelease npm versions (like `1.0.0-rsc.2`). Prerelease releases are hidden from the main GitHub page of the repo and users can't find them. Always use `--latest` instead.

**Do NOT use `--notes-file CHANGELOG.md`** — that dumps the entire changelog into the release body.

### Merging unpublished versions into release notes

If `package.json` was bumped multiple times without publishing (e.g. npm has 0.0.89, package.json has 0.0.101, you're publishing 0.0.102), the GitHub release notes must merge ALL changelog entries from 0.0.90 through 0.0.102 into a single release. Users jumping from 0.0.89 to 0.0.102 need to see everything that changed.

Sort merged entries by impact — big new features first, bug fixes last. Remove duplicates where a feature was added then refined across versions (only describe the final state).

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

also make sure that we always use `workspace:^` instead of `workspace:*` for workspace dependencies in package.json. using :\* will use the pinned package in released npm package.json files, instead of ^.

## .changeset based changelogs

some packages use the changeset convention for changelogs. so instead of updating the changelog directly they create .md files inside `.changeset` folder. with shape

```md
---
"packagename": minor
---

Changelog item entry here. with examples
```

For packages that contain these `.md` files we should

- read the .md files inside `.changeset` if any (also check in parent folders if this is a workspace. sometimes `.changeset` is at the repo root)
- update the CHANGELOG.md for the packages, adding each one of these .md entries content as a list item for the new version. Keep all content, if there are code snippets or examples, add them too, indented into the list item
- if any entry adds a **new feature or capability**, use a **minor** bump
- use **patch** only when all entries are fixes or non-feature improvements
- then delete these .md files
- publish as normal

NEVER use the changesets cli to publish or update changeset based packages. always do these steps manually.

## prereleases

if a `package.json` version has a version like `1.18.0-rsc.0` you MUST add the option --tag rsc. rsc is for the tag used in the version.

example: `pnpm publish --tag next` for `1.0.0-next.0`. the `.0` does not matter in what `--tag` name you would use.

## working directory

do not change cwd if there are git diff that don't let you publish, instead just commit them with the appropriate message. do this before starting the publish.

## additional context
