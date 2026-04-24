I am Tommy. My github username is remorses. My x.com is \_\_morse

never commit anything unless asked by the user precisely

NEVER run rm -rf on ANY folder outside of project directory! NEVER even run things like rm -rf ~/.bun/install/cache

always use kebab case for new filenames. never use uppercase letters in filenames

avoid creating tiny files. if a new file would be under 100 lines, prefer adding the code to an existing file or do a small refactor so related code stays together.

ALWAYS use the right package manager for ts repos. you can see the right one based on lock files like bun.lock. for example bun publish instead of npm publish.

## pnpm/bun workspaces

always prefer root folders for all packages and setting workspaces: ./\*. without a parent packages/ folder

instead of using workspace:\* use workspace:^ for local packages versions. so if published they won't use the pinned version but the ^ version.

## type checking

to type check typescript projects try to use their typecheck package.json script if present. if not try build. this is preferable than `tsc`. also try to never pass --noEmit. so that our typechecking path does both things: check and emit the compiled assets. otherwise the dist folders would remain stale even after our changes.

## scripts

if you need to create scripts always prefer typescript over bash or js. never create new files in js unless strictly required.

prefer always writing scripts in Node.js and run them with tsx or bun. If you ever need to run them with python for some reason use uv and uvx

scripts should always progressively log to let user know what is happening and current state in case of crash in the middle of the script. for example for a script that updates rows in the database and does so with multiple update statements run one by one you should log each update so that we know the script is currently running and doing something.

## multiline strings

always use `string-dedent` for multiline strings so they stay nicely formatted and readable, especially for markdown, prompts, SQL, HTML, and long error messages.

when using `string-dedent`, always make the first and last line empty. otherwise `string-dedent` can throw.

when you need a fenced code block with a language like `js`, `ts`, or `tsx`, assign the dedented string to a variable like `JS`, `TS`, or `TSX` so editors can infer syntax highlighting more reliably.

```ts
import dedent from 'string-dedent'

const message = dedent`
  ## Summary

  - first item
  - second item
`

const TSX = dedent`
  export function Button() {
    return <button>Hello</button>
  }
`
```

## planning

when the user asks you to plan, they want you to read all relevant files and create a concrete plan with steps: sections where you describe what files you would update and what tests you would add to validate the new changes.

NEVER output a plan where you "plan" to read files or plan to explore the codebase. the goal of a plan is to do these things before starting the implementation part. you have to explore the codebase, read files, validate assumptions BEFORE showing the user the plan in chat.

if there are multiple ways to implement the changes, show a high-level summary of each approach before showing the full plan.

## playwriter

ALWAYS use locally installed playwriter without npx or bunx. This ensures you use the local version, which may have fixes and improvements not yet published.

## git

NEVER rewrite git history. NEVER amend commits unless asked. NEVER restore or revert unless specifically asked. NEVER call git reset. prefer merge over rebase or squash

when continuing git operations in non-interactive shells, avoid commands that may open an editor and hang. use `GIT_EDITOR=true` for `git rebase --continue`, `git cherry-pick --continue`, and `git revert --continue`.

examples:

```bash
GIT_EDITOR=true git rebase --continue
GIT_EDITOR=true git cherry-pick --continue
GIT_EDITOR=true git revert --continue
```

for commits, always use `git commit -m 'message'` or a heredoc, never bare `git commit`.

NEVER use double quotes in `git commit -m` strings. backticks inside double quotes trigger shell command substitution and can silently mangle the commit message. if you need inline code in the commit body, use single quotes for one-line messages or a heredoc for multiline messages.

if a previous interactive git command was aborted and git mentions a stale lock, first make sure no git/editor process is still running, then retry the non-interactive command. only remove a stale `.git/.../index.lock` after confirming no git process is active.

when creating a new branch, always check if you're in a fork (origin and upstream remotes are different). if so, switch to upstream's default branch first:

```bash
# check if upstream exists and differs from origin
git remote -v

# if in a fork, get default branch name and switch to it
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch upstream
git checkout upstream/$DEFAULT_BRANCH
```

NEVER do `git stash pop`. ALWAYS apply. so we can get back the stash if needed.

## git commits

ONLY commit when user asks to do so.

before committing, always check what files were changed and review the git diff. Only commit your changes. NEVER assume there are no other changes—other agents may have made changes you don't know of. If there are unrelated changes, use `critique hunks list` to list hunks and stage only the relevant ones with `critique hunks add id1 id2`. See `critique --help` for more info.

If staging hunks is too difficult NEVER use git stash to remove other changes. just commit the whole file instead and keep things simple. it doesn't matter if some other changes end up in the commit.

if user says "commit all" then also commit other changes, grouping them accordingly and using detailed commit messages.

never amend commits or rewrite git history

always write very detailed commit messages. Feel free to include diagrams, markdown, tables, lists, quotes, etc.

always append the current opencode session id at the end of every commit message. format it as a final line like `Session: ses_xxx`. later you can use kimaki cli to read session as markdown from past commits to understand why they were made.

NEVER use `chore: commit remaining workspace updates`. read the diff and analyze it to commit with descriptive message. splitting in many commits to split changes by goal.

## diff

use `git diff` to see changes being made. do this at start of sessions. to see if we are working on a dirty branch with existing changes from a previous session

also use `git status -s -u` to add newly added files, not shown in git diff.

## Paginating Large Diffs

For large diffs, paginate using `sed` to view specific line ranges with no overlap:

```bash
# Page 1: lines 1-500
git diff $BASE_REF...HEAD -U20 -- ':!*.lock' | sed -n '1,500p'

# Page 2: lines 501-1000
git diff $BASE_REF...HEAD -U20 -- ':!*.lock' | sed -n '501,1000p'

```

Continue incrementing by 500 until output is empty. This is needed to see large diffs without tools truncating the output.

### searching past commits

use 3 approaches to find commits that updated certain code

```sh

#search in the commit message
git log --grep="search term"

# Search for commits that added or removed a string
git log -S "search term"

# Search with regex among diff of commits
git log -G "regex pattern"
```

Use all three approaches, passing variable names and function names as search strings.

### full history of a line

use `git log -L` to see every commit that ever touched a specific line. unlike `git blame` which only shows the last commit per line, `git log -L` traces the full evolution. git follows the actual content of the line, not just its position — it tracks the line through insertions, deletions, and moves above it.

use this to understand the goal or reason behind a change: find the commits that touched a line, then read their messages or full diffs for context.

```bash
# all commits that touched line 42
git log -L 42,42:path/to/file.ts

# all commits that touched lines 10-20
git log -L 10,20:path/to/file.ts

# all commits that touched a specific function
git log -L :functionName:path/to/file.ts

# compact: just commit hashes and messages
git log -L 42,42:path/to/file.ts --oneline

# then read the full diff of a specific commit
git show <hash>
```

### full history of a file or folder

use `git log -- path` to see every commit that touched a file or folder. add `--follow` for files to track history across renames.

```bash
# all commits that touched a file
git log --oneline -- path/to/file.ts

# track history across renames (single file only)
git log --oneline --follow -- path/to/file.ts

# all commits that touched a folder
git log --oneline -- src/components/

# with diffs
git log -p -- path/to/file.ts

# with file change stats
git log --stat -- path/to/file.ts
```

the `--` separator explicitly marks where paths begin, preventing git from confusing filenames with branch names.

## github

before creating any gh pr or issue, ask for confirmation only when the target github repository owner is not remorses. if the repo owner is remorses, do not ask for confirmation first

when searching for working examples of a code pattern, always use `gh search code` and `gh search repos` first before guessing. search for the concrete api names, method names, and small string snippets from the pattern you want.

for example, search both the method and the surrounding shape:

```bash
# search code usages of a concrete API or method
gh search code 'std.process.Child.init "stdout_behavior = .Pipe" language:Zig' --limit 30

# search for a bigger pattern with multiple clues
gh search code 'std.process.Child.init "stdout_behavior = .Pipe" "stderr_behavior = .Pipe" "std.Thread.spawn" language:Zig' --limit 30

# search repos first when you want better examples to inspect deeply
gh search repos 'command runner stdout stderr streaming zig' --limit 30
```

then sort candidate repos by stars to bias toward higher quality examples. if `gh search code` returns repo names, run a repo search and sort those repos by stars before choosing which files to read in detail.

prefer this workflow:

1. search code for the exact method/pattern
2. collect the repo names from promising hits
3. search repos for those projects or that topic
4. sort by stars / credibility
5. read the best few examples, not just the first random hit

when reporting findings, include the repo URLs and file paths for the best examples so they are easy to inspect later.

if you open PRs or issues with gh cli first check what is the correct commit, title and body format for the pr or issue. don't use headings in the body (it looks like AI slop), instead try to use bold text as headings which is more refined looking and less commonly done by AI.

Never use `\n` in `--body` or `--message` flags; shells don't turn these into real newlines. For multiline content, always use a heredoc:

```bash
gh pr create --title "title" --body "$(cat <<'EOF'
First paragraph.

Second paragraph with `code`.
EOF
)"
```

after creating a pr always print the pr url to the user, then watch for ci to complete successfully using command like

```bash
gh pr checks --watch --fail-fast
```

to handle PR review comments:

```bash
# view reviews and get thread IDs
gh pr-review review view 42 -R owner/repo --unresolved

# reply to a review comment
gh pr-review comments reply 42 -R owner/repo \
  --thread-id PRRT_kwDOAAABbcdEFG12 \
  --body "Fixed in latest commit"

# resolve a thread
gh pr-review threads resolve 42 -R owner/repo --thread-id PRRT_kwDOAAABbcdEFG12
```

NEVER use git to revert files to previous state if you did not create those files yourself! there can be user changes in files you touched, if you revert those changes the user will be very upset!

Never submit pending reviews with placeholder messages like "Reviewing suggestions". If a pending review blocks comment replies, dismiss it instead of submitting with generic text comment.

NEVER fabricate GitHub GraphQL node IDs. Always query them from the API or capture them from the creation mutation's return fields.

NEVER use we or our in messages. Write as if you were me, making the body personal. Write casually and concisely, not like a robot. Focus on telling information quickly without stupid fluff and corporate idioms.

## github releases

always omit chores or internal things from github release. end users are going to read these so we should omit internal not user facing changes and instead be very detailed on user facing APIs changes and features. adding code snippets and nice code formatting.

NEVER pass `--prerelease` to `gh release create`, even for prerelease npm versions (like `1.0.0-rsc.2`). prerelease releases are hidden from the default GitHub releases view and users can't find them. always use `--latest` instead.

## updating PRs and issues

always update existing PRs, issues, or comments instead of recreating them. use `gh pr edit` or `gh issue edit` to update title/body.

nicely format them using markdown. do not write big blobs of text.

when checking if there is already a pr for current branch always check upstream first

never close a PR or issue without explicit user confirmation. if something needs to change, update it instead of closing and recreating.

## planning

when planning a task, first read all files relevant to the plan:

- the main files you'll be modifying
- files they import (dependencies)
- files that import them (importees/dependents)

this gives you the full picture of the codebase before writing the plan. after gathering context, use the prune tool to clean up read tool calls that ended up not being needed, saving context usage for the actual implementation

read all files you need! do not try to save context window by not reading files. instead DO read them and then prune them later if not relevant.

## updating AGENTS.md files

before updating agents instructions files, always double check that they are not generated by other commands. If they are, never edit them directly. This is common—just read the first 10 lines to see if the AGENTS.md says it is being generated by another script. If so, look at the root package.json for the script that generates it. Usually there are other files with project-specific instructions you can edit instead, like PROJECTNAME_AGENTS.md.

## tasks

when using task tool always be as detailed as possible on what you want: list goal of task, overall goal of session, requirements for task, tips for subagent, overall scope of project and why task is being used.

## web search

for web searches use `googlesearch` tool (which uses Gemini with Google Search grounding).

when possible, ask the search to retrieve and include relevant GitHub project URLs in the results.

## model ids

if you need to look up model ids, use `https://models.dev/api.json`.

to list OpenAI models sorted by latest release first:

```bash
curl -s https://models.dev/api.json | jq '.openai.models | to_entries | map(.value) | sort_by(.release_date) | reverse | map(.id)'
```

to swap providers, replace `.openai.models` with another provider key like `.anthropic.models` or `.google.models`.

## docs .md files

if user asks you to create .md files with findings always put them in a docs folder and not at root level or in src

## background processes

for running dev servers and other long-running commands, use tuistory background sessions with names. prefer `tuistory launch`, `tuistory read`, and `tuistory wait` over shell sleeps because they react to real process output.

## compounding engineering

if some particular planning architecture/bug debugging session/code implementation required a lot of effort or back and forth always add the learned knowledge, lessons & tips in comments in the relevant code: explain shortcuts or preferences to never make the same mistakes again.

you can add it at the top of the file in a comment if there is no specific portion of the code where the comment fits

if you want to add some knowledge about the overall codebase write it in a ./docs/ .md file with title & description frontmatter and reference it in AGENTS.md (first checking if there is a \*\_AGENTS.md that is specific about this project that is not generated)

## testing

vitest or bun are the preferred frameworks for testing ts code.

`.toMatchInlineSnapshot` is the preferred way to write tests. Place it before an expect call, leaving it empty the first time, then update with -u. Check the git diff for the test file every time you update with -u to make sure the snapshots are expected and correct.

Snapshots are great because they let you discover the behaviour of the code, you can use them to discover the results of functions or their behaviour.

for multiline inline snapshots always prefix them with \n with `.toMatchInlineSnapshot('\n' + content)` so they look good.

NEVER use mocks in tests. NEVER mock modules. tests should try to test as much of the code as possible, and not mock parts of the code. for example if we are testing a NAPI js package you must not mock the native side with fake functions. instead you must test the end to end flow of the code.

## linting

always run `lintcn lint` at the end of an editing session to catch errors or warnings introduced by the changes.

if `lintcn lint` reports issues for your new changed files fix them 

do not add a local lintcn config just to make it run. there is a global lintcn config shared across all my projects.

if lintcn has a bug or some rules are blatant noise and have a bug you can tell user we should start a session in `/Users/morse/Documents/GitHub/lintcn/` to fix it at end of session.

## test driven development

you should write failing tests first, make sure they fail, then write the code or fixes that will make them pass. refactoring them if needed

if you have difficulties making some tests pass in some edge cases do not apply workarounds in the tests, instead aks help to the user or oracle agent if present. for example if we are developing a NAPI module and tests do not pass in linux you should not change the tests to make them pass in linux or skip them.

leave them failing instead and report to the user the issues faced as a last resort

if user starts a session asking you to run existing tests and they fail try looking at recent commits to find possible regression reasons

# opensrc

use opensrc to read source code of npm packages, PyPI packages, crates, or GitHub repos. it downloads into a global cache at `~/.opensrc/`.

```sh
# fetch and print the cached path (fetches on cache miss)
bunx opensrc path zod
bunx opensrc path pypi:requests
bunx opensrc path owner/repo
bunx opensrc path owner/repo@v1.0.0

# list all cached sources
bunx opensrc list

# remove cached source
bunx opensrc remove zod
```

use `opensrc path <package>` to get the absolute path, then read/grep files from there.

this is preferable over manually cloning repos in tmp

# git worktrees

when user asks you to create new worktree for the session do this

```sh
git worktree add ../{reponame}-{branchname} -b {branchname} upstream/main
```

sometimes upstream/main is different, check what is the default branch first, it might not be main

## kimaki

for kimaki.xyz commands always use global kimaki instead of npx kimaki, it will use the local version of kimaki cli with latest changes

after I ask you to push, call the tool kimaki_archive_thread so the thread is removed from Discord sidebar and completed tasks are not shown in left sidebar.

## committing only certain hunks

sometimes other agents added unrelated changes in git diffs

when committing you should first see the git diff, then if the files only have your changes commit those files only with

```bash
git commit path/to/file1 path/to/file2 -m 'commit message'
```

If instead other changes exist in those same files, you can use the critique hunks command to stage only some portions and leave unrelated changes unstaged and uncommitted

```
# List all unstaged hunks with stable IDs
critique hunks list

# List staged hunks
critique hunks list --staged

# Filter by file pattern
critique hunks list --filter "src/**/*.ts"

# Stage specific hunks by ID
critique hunks add 'src/main.ts:@-10,6+10,7'

# Stage multiple hunks
critique hunks add 'src/main.ts:@-10,6+10,7' 'src/utils.ts:@-5,3+5,4'

```

> always use global critique command instead of using bunx so you use the latest version with latest changes, critique in PATH is using the local version of critique with latest changes and fixes

## sharing files with boox tablet and devices

you can generate pdfs to view in my boox device by dropping them in the drive folder /Users/morse/Documents/googledrive/

this way I can read those files in my e ink tablet. for example useful when using critique to generate a pdf of the changes with `critique --pdf /Users/morse/Documents/googledrive/changes-name.pdf`

after that drive will sync it automatically

## pbcopy

if i ask you to copy something use pbcopy command to do it. don't tell me to run the command to copy. you must run the pbcopy command yourself.

## editing skills

If I ask to edit a skill search for the skill path in cwd not inside kimaki folder if the skill references it. search for files SKILL.md

other skills can be inside ~/.config/opencode/skills

`~/.config/opencode/` is a git repo. you can commit skills and other files there, also run the critique command inside it to show diffs.

if after following a SKILL.md content you get errors or find the skill to be wrong always tell about it to the user, proposing we should update the skill content

## state management (non-React)

For non-React code (servers, CLIs, extensions). React already encapsulates state in components — only use a central store when state is shared across many components.

Minimize mutable state (variables, Maps, objects, booleans). Most bugs come from state that shouldn't exist.

**Rules:**

- Minimize — use as few mutable variables as possible
- Derive — if it can be computed from existing state, compute it, don't store it
- Centralize — one Zustand store as single source of truth, no scattered variables
- Centralize updates — all state changes go through `setState((s) => newState)`
- One subscribe — all reactive side effects in one place

```ts
// BAD: cached index that can desync
const userIndex = new Map<string, User>();

// GOOD: derive on demand
const findUser = (id: string) => store.getState().users.get(id);
```

Load the `zustand-centralized-state` skill for the full pattern.

**React:** Avoid `useEffect`. Put code inside event handlers instead if possible .

## writing READMEs and docs

markdown files must follow progressive disclosure: the top of the document must be easy to follow and contain gist, essence of the document. the section that follows should cover basic concepts, as the document progresses the section theme becomes more complex and advanced.

for example if you are writing a README for a new Express like React framework you would put the tagline at the top, in a few words it should explain what the framework is and the value proposition. then a code snippet example that shows the overall gist of the framework. then a list of features. then a section for each feature, starting from the core and basic ones to then go to the most advanced. agent only rules should be put at the bottom (exception is how to install skills, that is an user facing section, close to the top).

each paragraph should ideally have a code snippet example or diagram. it's much easier for the user to understand by example than to read intricate prose. use tables to display comparisons or tabular data.

### diagrams in markdown

make heavy use of ASCII diagrams inside code blocks to explain architecture, flows, and relationships. diagrams should try to cover the full width of the page, which is about **100 characters**. don't cram everything into narrow 50-char diagrams.

prefer a **varied, organic layout**. not every label needs to be inside a box. mix plain text labels, boxes for major components, and directional arrows (►, ◄, ▼, ▲) for connections. avoid perfectly symmetric grid layouts; asymmetric fanouts and side annotations look more natural and are easier to read.

all connections between nodes must use directional arrows. never use plain lines (───) without an arrowhead. always verify alignment by counting characters precisely: every box border (┌┐└┘) must match the width of its content lines (│...│). use the diagram-fixer agent after creating diagrams.

If you need to embed rules for agents or complex topics you can use details html block to toggle them so the user does not need to see walls of text or non important content while skimming the document.

use bold to mark important key words in each paragraph to make it easy for the user to skim the content.

never use emdashes, they are over used by AIs, we want to sound human-like and not AI generated. Instead of using emdash use dots, semicolons and commas, which can accomplish the same goal. Keep phrases short and easy to read. Use bold to mark important words. Ideally one per paragraph. Paragraphs should be short, no wall of text. 

## validating URLs in markdown

every time you add a URL to a markdown file (README, docs, SKILL.md, AGENTS.md, etc.), immediately validate it with curl. check that the status is 200 and the response body is not empty or an error page.

```bash
# validate a URL after adding it
curl -sI "https://example.com/path" | head -1
# expected: HTTP/2 200

# also check content is valid (not a 404 page served with 200)
curl -s "https://example.com/path" | head -5
```

if the URL returns a non-200 status or the content looks wrong (error page, redirect to login, etc.), fix it before committing.

you can add callouts in README files using github syntax:

> [!IMPORTANT]
> content

## running processes in background

use tuistory to run processes in background. see `bunx tuistory --help` for how to use it. prefer it over tmux even when tools suggest using tmux
