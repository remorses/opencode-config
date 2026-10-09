I am Tommy. (Tommaso De Rossi) GitHub: remorses. X: __morse

Report to me in chat in concise ASD-STE100 Simplified Technical English. I have ADHD.

## code quality

No hacks, workarounds, monkey patches, or duct tape. Fix the underlying flaw properly, or say honestly that the task can't be done without a hack. Never ship partial solutions.

Backwards compatibility does not matter. If something is poorly designed, fix it even if it breaks APIs.

Values: correctness over convenience, clarity over cleverness, simplicity over complexity, doing it right over doing it now, honesty above everything.

After every change, briefly report any part you are not confident about or that could be fragile.

- Code comments: short, one line if possible. Skip them when code is self-descriptive. No essay block comments.
- If code is complex only because of a dependency or runtime limitation, add a comment that starts with `// TODO`. Say what the simpler implementation is and link the relevant GitHub issue or docs, so we can simplify it later. Example: `// TODO: use native fetch streaming once Workers support it. https://github.com/cloudflare/workerd/issues/123`
- Never `rm -rf` any folder outside the project directory.
- kebab-case for new filenames.
- Avoid tiny files (<100 lines). Prefer adding code to an existing related file.
- Use the package manager matching the lockfile (e.g. `bun publish` if `bun.lock`).
- Write scripts in TypeScript (run with tsx or bun), never new .js/bash files unless required. Python only via uv/uvx.
- Scripts must log progress step by step (e.g. each DB update), so a crash shows where it stopped.
- Don't add package.json scripts unless asked.
- Put .md findings docs in `docs/`, never at root or in `src/`.
- Non-React state: minimize mutable state, derive instead of caching. See `zustand-centralized-state` skill.
- React: avoid `useEffect`; put logic in event handlers.

## typescript

- Typecheck with the `typecheck` script, else `build`. Never pass `--noEmit`, so dist stays fresh.
- My projects usually set `noImplicitAny: false`. Add it to tsconfig.json if many errors come from it.
- Workspaces: packages in root folders (`workspaces: ./*`), no `packages/` parent. Use `workspace:^`, not `workspace:*`.

Use `string-dedent` for multiline strings (markdown, prompts, SQL, HTML, long errors). First and last line MUST be empty or it throws. For embedded code, name the variable `TS`, `TSX`, `JS` for editor highlighting.

```ts
import dedent from 'string-dedent'

// first and last line MUST be empty
const message = dedent`
  ## Summary

  - first item
  - second item
`
```

## planning

When asked to plan: read all relevant files first (files to modify, their imports, their dependents), validate assumptions, then show a concrete plan listing files to change and tests to add. Never plan to "explore" or "read files" later. Read every file you need; never skip reads to save context. If there are multiple approaches, summarize each before the full plan.

## testing

**Never add useless tests.** Every test must earn its place and its runtime.

- Only test complex logic: parsers, state machines, algorithms, edge-case-heavy code, real bugs (regression tests). Never test trivial code, getters, glue, config, or things the type system already guarantees.
- No tests for trivial UI tweaks (spacing, colors, truncation, default-open). Verify with playwriter instead.
- Keep tests **fast**. No sleeps, fixed timeouts, polling loops, or needless network/process spawning. Prefer one test covering a full flow over many tiny overlapping tests. If a test is slow, make it fast or delete it.
- Before adding a test, check existing tests. Extend one instead of duplicating coverage.
- Use vitest or bun test.
- Write failing tests first, confirm they fail, then implement.
- Prefer `.toMatchInlineSnapshot()`: leave empty, run with `-u`, then review the test file diff to confirm the snapshot is correct. Snapshots also help discover real behavior. Prefix multiline snapshots with `'\n'`.
- No mocks, no module mocking. Test the real end-to-end flow (e.g. real native side of a NAPI package, not fake functions).
- Never weaken, skip, or special-case tests to make them pass (e.g. skipping on Linux). Leave them failing and report the problem, or ask the oracle agent.
- If existing tests fail at session start, check recent commits for regressions.

## linting

Run `lintcn lint` at the end of an editing session, inside the edited package (not monorepo root). Fix issues in files you changed. Never add a local lintcn config; a global one exists. If a rule looks buggy or noisy, suggest a session in `/Users/morse/Documents/GitHub/lintcn/`.

## git

- Never commit unless I ask. Never amend, rebase history, `git reset`, or force-push unless asked. Prefer merge over rebase/squash.
- Never revert or restore files you did not create. They may contain my changes.
- Never `git stash pop`; use `git stash apply`.
- At session start, run `git diff` and `git status -s -u` to see existing uncommitted work.
- Use `GIT_EDITOR=true` for `rebase/cherry-pick/revert --continue`.
- Commit messages: `-m '...'` with single quotes or a heredoc. Never double quotes (backticks get executed).
- Before branching, check if repo is a fork (`git remote -v`). If so, branch from `upstream/<default-branch>`.
- To find why code changed, load the `git-history` skill.

### committing

- Review the diff first. Other agents may have unrelated changes in the tree. Commit only your changes: `git commit path/a path/b -m '...'`.
- If a file mixes your changes with others, stage hunks with critique (IDs are content hashes like `src/main.ts:@a1b2c3d4e5f6`):

  ```bash
  critique hunks list [--staged] [--filter 'src/**/*.ts']
  critique hunks add 'src/main.ts:@a1b2c3d4e5f6' 'src/utils.ts:@f6e5d4c3b2a1'
  ```

- If hunk staging is too hard, commit the whole file. Never use stash to hide other changes.
- "commit all" means commit everything, split into commits by goal. Never use generic messages like `chore: commit remaining workspace updates`.
- Write detailed commit messages (lists, tables, diagrams are fine).
- Last line of every commit message: `Session: ses_xxx` (current opencode session ID).

## github

- Ask before creating PRs/issues only if the repo owner is not remorses. Never close a PR or issue without my confirmation.
- Load the `github-prs` skill before creating or editing PRs, issues, comments, releases, or review replies.
- PRs, issues, and comments must be super concise: a few short lines. No code refs, no file lists, no long explanations unless I ask.
- Load the `gh-search` skill before guessing how an API or pattern is used.

## tools

- **critique, playwriter, kimaki, lintcn, tuistory, opensrc**: always use the global binary, never `npx`/`bunx`. They are local builds with the latest fixes.
- **opensrc**: `opensrc path <pkg|pypi:pkg|owner/repo[@ref]>` to read dependency source. Prefer over cloning into tmp.
- **tuistory**: use named background sessions for dev servers and long-running commands, not tmux or shell sleeps.
- **web search**: use `googlesearch`; ask it to include GitHub URLs.
- **model ids**: `curl -s https://models.dev/api.json | jq '.openai.models | to_entries | map(.value) | sort_by(.release_date) | reverse | map(.id)'` (swap `.openai` for other providers).
- **pbcopy**: when I ask to copy something, run `pbcopy` yourself.
- **Discord CDN URLs**: wrap in single quotes (they contain `&`). Verify with `file`; tiny or "ASCII text" means mangled or expired link.
- **kimaki**: after I ask you to push, archive the thread with `kimaki session archive`.

## AGENTS.md and knowledge

- Before editing an AGENTS.md, check its first lines for a "generated" notice. If generated, edit the source (often `PROJECTNAME_AGENTS.md` or a script in root package.json).
- After hard debugging or long back-and-forth, write the lessons as concise comments in the relevant code (or top of file). Codebase-wide knowledge goes in `docs/*.md` with title/description frontmatter, referenced from the non-generated AGENTS.md.

## skills

- Personal skills: `~/.config/opencode/skills` (this dir is a git repo; commit and run critique here).
- Public skills: `~/.config/opencode/skills-repo/` (submodule of remorses/skills). Add `repo: remorses/skills` in frontmatter.
- Private skills: `~/.config/opencode/private-skills/` (submodule of remorses/private-skills). Add `repo: remorses/private-skills`. Never publish.
- Never read or edit `/Users/morse/Documents/GitHub/kimakivoice/cli/skills`; it is synced from other repos. Edit skills in their source repo (find it via `kimaki project list`).
- If a skill's instructions are wrong, tell me and propose a fix.
- When I correct you on something a skill covers, ask: "should we incorporate X into Y skill?"

## writing READMEs and docs

Applies to READMEs, `docs/*.md`, SKILL.md, and AGENTS.md files.

**Progressive disclosure.** The top must be easy and hold the gist. Each following section gets more advanced. Example for a new Express-like React framework: tagline with value prop in a few words, then a code snippet showing the gist, then a features list, then one section per feature from core to advanced. Agent-only rules go at the bottom (exception: skill install instructions are user-facing, keep them near the top).

**Show by example.** Every paragraph should have a code snippet or diagram when possible. Examples are easier to understand than intricate prose. Use tables for comparisons and tabular data.

**Skimmable.** Short paragraphs, short phrases, no walls of text. Bold one key word per paragraph.

**Sound human.** Never use em dashes (AI overuses them). Use periods, semicolons, commas.

**Split long sections.** If a `##` section grows past ~5 paragraphs or ~3 code blocks, split it into `###` subsections with short headings.

**Only good examples.** Never write BAD/GOOD comparisons. Show the correct pattern directly; it halves the length.

**Hide secondary content.** Put long agent rules or non-essential detail in `<details>` blocks. GitHub callouts (`> [!IMPORTANT]`) are allowed in READMEs.

**Validate URLs.** After adding any URL, curl it. Status must be 200 and the body must be real content, not an error page or login redirect. Fix it before committing.

```bash
curl -sI 'https://example.com/path' | head -1   # expect HTTP/2 200
curl -s 'https://example.com/path' | head -5    # expect real content
```

### diagrams

- Use ASCII diagrams in code blocks heavily to explain architecture, flows, and relationships.
- Use the full width, about **94 chars**. Never exceed it; don't cram into 50-char diagrams.
- Varied, organic layout: mix plain text labels, boxes for major components, and side annotations. Avoid symmetric grids; asymmetric fanouts read better.
- Every connection needs an arrowhead. Never plain `───` lines without one.
- Count characters: every box border (┌┐└┘) must match the width of its content lines (│...│).
