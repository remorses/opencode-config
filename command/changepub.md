---
description: Commit, update changelog, npm publish
agent: build
---

- If you miss relevant context do git diff or read last commit if there are no changes in HEAD. so you understand what was just done in the repo
- Bump the relevant package.json version. NEVER do major bumps
- Update the changelog with your changes, in bullet points, adding a new section with the right npm version, find the right CHANGELOG.md first or add one
- Commit with appropriate commit message
- run npm publish, in the appropriate package folder
- If publish fails for tsc errors or other issues, try to resolve them and run it again
- push your changes to github
