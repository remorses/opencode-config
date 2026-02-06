---
description: Commit, update changelog, npm publish
agent: build
---

- If you miss relevant context do git diff or read last commits if there are no changes in HEAD. since the last tag. so you understand what was just done in the repo
- Bump the relevant package.json version. NEVER do major bumps
- Update the changelog with your changes, in bullet points, adding a new section with the right npm version, find the right CHANGELOG.md first or add one
- Commit with appropriate commit message for the release
- run npm publish, in the appropriate package or packages folders
- create a tag with the package-name@version-number
- If publish fails for tsc errors or other issues, try to resolve them and run it again
- push your changes to github, with tags too
- create a release on github with gh cli for the tag. mention external contributors with @ using "thanks @ghusername for the contributions" in the list items. set it as latest. use changelog body for the release content.

IMPORTANT! use pnpm publish if there is a pnpm lock file. use bun publish if there is a bun lockfile. do not blidnly use npm! only as a last resort. otherwise workspace references in package.json will remain and break the published package

after calling publish command like bun publish or pnpm publish ALWAYS do pnpm i or bun i after. this is needed so lockfile is updated with updated package version and workspace versions are resolved to the correct one later on.

if multiple packages changed publish them in topological order, where the dependencies are published first. always publish dependencies if there were changes in them.
