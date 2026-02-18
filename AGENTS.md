never commit anything unless asked by the user precisely

NEVER run rm -rf on ANY folder outside of project directory! NEVER even run things like rm -rf ~/.bun/install/cache

always use kebab case for new filenames. never use uppercase letters in filenames

ALWAYS use the right package manager for ts repos. you can see the right one based on lock files like bun.lock. for example bun publish instead of npm publish.

if you need to create scripts always prefer typescript over bash or js. never create new files in js unless strictly required.


## planning

when the user asks you to plan, they want you to read all relevant files and create a concrete plan with steps: sections where you describe what files you would update and what tests you would add to validate the new changes.

NEVER output a plan where you "plan" to read files or plan to explore the codebase. the goal of a plan is to do these things before starting the implementation part. you have to explore the codebase, read files, validate assumptions BEFORE showing the user the plan in chat. 

if there are multiple ways to implement the changes, show a high-level summary of each approach before showing the full plan.

## playwriter

ALWAYS use locally installed playwriter without npx or bunx. This ensures you use the local version, which may have fixes and improvements not yet published. 

## git

NEVER rewrite git history. NEVER amend commits unless asked. NEVER restore or revert unless specifically asked. NEVER call git reset. prefer merge over rebase or squash

when creating a new branch, always check if you're in a fork (origin and upstream remotes are different). if so, switch to upstream's default branch first:

```bash
# check if upstream exists and differs from origin
git remote -v

# if in a fork, get default branch name and switch to it
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch upstream
git checkout upstream/$DEFAULT_BRANCH
```

## git commits

ONLY commit when user asks to do so.

before committing, always check what files were changed and review the git diff. Only commit your changes. NEVER assume there are no other changes—other agents may have made changes you don't know of. If there are unrelated changes, use `critique hunks list` to list hunks and stage only the relevant ones with `critique hunks add id1 id2`. See `critique --help` for more info.

if user says "commit all" then also commit other changes, grouping them accordingly and using detailed commit messages.

never amend commits or rewrite git history

always write very detailed commit messages. Feel free to include diagrams, markdown, tables, lists, quotes, etc. 

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

before creating any gh pr or issue output the title and body in chat and ask for confirmation first

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


NEVER use we or our in messages. Write as if you were me, making the body personal. Write casually and concisely, not like a robot. Focus on telling information quickly without stupid fluff and corporate idioms.

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

## reading images

ALWAYS use the task tool for reading/analyzing images. never read images directly with the read tool as images consume a lot of context window space.

when analyzing an image, pass a detailed description in the task prompt of what you want to know. be specific about what aspects to examine and what information to return.

example: if detecting clipping issues in a screenshot, ask the task to describe in detail whether any UI elements are clipped, cut off, or overflowing their containers, and to report the specific locations and severity of any issues found.

the subagent will read the image and return only the relevant textual findings, saving significant context.

## docs .md files

if user asks you to create .md files with findings always put them in a docs folder and not at root level or in src

## background processes

for running dev servers and other long-running commands, use tmux background sessions with names

## compounding engineering

if some particular planning architecture/bug debugging session/code implementation required a lot of effort or back and forth always add the learned knowledge, lessons & tips in comments in the relevant code: explain shortcuts or preferences to never make the same mistakes again.

you can add it at the top of the file in a comment if there is no specific portion of the code where the comment fits

if you want to add some knowledge about the overall codebase write it in a ./docs/ .md file with title & description frontmatter and reference it in AGENTS.md (first checking if there is a \*\_AGENTS.md that is specific about this project that is not generated)

## testing

.toMatchInlineSnapshot is the preferred way to write tests. Place it before any expect call, leaving it empty the first time, then update with -u. Check the git diff for the test file every time you update with -u to make sure the snapshots are expected and correct.

for multiline inline snapshots always prefix them with \n with `.toMatchInlineSnapshot('\n' + content)` so they look good.

NEVER use mocks in tests. NEVER mock modules.

# opensrc

to read source code of npm packages or repos you can do:

```sh
bunx opensrc npmpackagename
opensrc github:owner/repo
opensrc owner/repo@v1.0.0
opensrc owner/repo#main
```


this will download them in a local ./opensrc folder

this is preferable over manually cloning repos in tmp or using gitchamber

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
git commit path/to/file1 path/to/file2 -m "commit message"
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
