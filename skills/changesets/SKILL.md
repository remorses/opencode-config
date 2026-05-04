---
name: changesets
description: >
  Changeset-based versioning workflow. Manually add .changeset/*.md files to
  describe changes instead of editing CHANGELOG.md directly. Changesets are
  consumed at publish time to bump versions and generate changelogs. Use this
  skill when adding changesets or when a repo has a .changeset/ folder.
---

# Changesets

Changesets is a workflow for versioning and publishing packages. Instead of manually editing `CHANGELOG.md` or bumping `version` in `package.json`, you drop a small markdown file inside `.changeset/` describing what changed. At publish time, these files are consumed to bump versions, generate changelog entries, and publish to npm.

## Always manual

Never run the `changeset` CLI command interactively. Never run `npx changeset`, `pnpm changeset`, or any variant. The changeset file is always created manually by writing a `.md` file directly into the `.changeset/` folder. The CLI's interactive wizard is designed for humans typing in a terminal; agents must write the file themselves.

## Adding a changeset

After making a noteworthy code change, create a new `.md` file inside `.changeset/` with a random kebab-case name (e.g. `cool-lions-dance.md`). The file has YAML frontmatter declaring which package(s) changed and the semver bump level, followed by a markdown description.

```md
---
'spiceflow': patch
---

Fix query parameter coercion for boolean arrays in GET handlers.
```

Multiple packages can be listed in one changeset:

```md
---
'spiceflow': minor
'create-spiceflow': patch
---

Add federation support for remote RSC components. The create-spiceflow
template now includes a federation example.
```

## Rules

1. **Never use `major`.** Use `patch` for fixes and `minor` for new features. Releases are frequent enough that breaking changes don't warrant a major bump.
2. **Only public packages.** Never add changesets for packages marked `"private": true` or without a `version` field in `package.json`.
3. **Don't edit CHANGELOG.md.** New changes must be added as changesets instead
4. **Never run the changeset CLI.** Always write the `.md` file manually.
5. **Present tense.** Write "add support for X", "fix bug with Y", not "added" or "fixed".
6. **Single concise paragraph.** Not bullet points or lists. Include code snippets if they help explain the change.
7. **One changeset per logical change.** If a PR has two unrelated changes, create two changeset files.

## What goes in the description

Focus on what the user sees, not internal refactoring details. Good changeset descriptions:

- Explain the user-facing behavior change
- Include a short code snippet if the API surface changed
- Mention the fix if it resolves a specific bug

Bad changeset descriptions: "update internals", "refactor code", "misc improvements".

## Pre-release mode

Some repos run in pre-release mode (configured in `.changeset/pre.json`). When active, versions are bumped with a pre-release tag like `1.20.0-rsc.3` instead of stable semver. The workflow stays the same: add changeset files normally, and the pre-release tag is applied automatically at publish time.

## Publishing (consuming changesets)

Publishing is a separate step from adding changesets, done by the user manually. The flow:

1. **During development:** add `.changeset/*.md` files alongside code changes
2. **At publish time:** the user runs a publish command which reads all pending changeset files, bumps `package.json` versions, writes `CHANGELOG.md` entries, and deletes the consumed changeset files
3. **Then:** packages are published to npm

Never attempt to publish or version-bump yourself. Adding changesets and publishing are decoupled on purpose. Your job is only step 1: writing the changeset file.

## Finding the .changeset folder

The `.changeset/` folder lives at the monorepo root (next to the root `package.json`). If your current working directory is inside a package subfolder, look in parent directories.
