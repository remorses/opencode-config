---
description: Commit, update changelog, npm publish
agent: build
model: anthropic/claude-sonnet-4-6
subtask: true
---

- run git diff to read current changes. including new files. run command like `git log packagename@0.4.55..HEAD` to read diff of commits since last release. you must first understand what was done in the repo
- Bump the relevant package.json version. NEVER do major bumps
- Update the changelog with your changes, in bullet points, adding a new section with the right npm version, find the right CHANGELOG.md first or add one
- Commit with appropriate commit message for the release
- run npm publish, (using right package manager like pnpm or bun) in the appropriate package or packages folders
- create a tag with the package-name@version-number
- If publish fails for tsc errors or other issues, try to resolve them and run it again
- push your changes to github, with tags too
- create a release on github with gh cli for the tag. mention external contributors with @ using "thanks @ghusername for the contributions" in the list items. set it as latest. use changelog body for the release content.

IMPORTANT! use pnpm publish if there is a pnpm lock file. use bun publish if there is a bun lockfile. do not blidnly use npm! only as a last resort. otherwise workspace references in package.json will remain and break the published package

after calling publish command like bun publish or pnpm publish ALWAYS do pnpm i or bun i after. this is needed so lockfile is updated with updated package version and workspace versions are resolved to the correct one later on.

if multiple packages changed publish them in topological order, where the dependencies are published first. always publish dependencies if there were changes in them.

to know if some package needs publisihing you can use `npm show packagename version` to see what is the last published version. important for workspaces to see what packages needs publishing.
