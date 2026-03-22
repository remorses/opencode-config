---
description: Commit in groups
# agent: build
subtask: false
model: anthropic/claude-sonnet-4-6
---

see git diff. if there are submodules also see their diff too.

if there are files that should not be tracked (like opensrc, node_modules, tsbuildinfo files) add them to .gitignore first

understand the diff by also reading relevant files if the diff are from files you did not touch

analyze the diff and their goal. think of a nice split of groups of commits to split the diffs

each commit should be focused on a single set of changes only

group unrelated things in different commits. be very detailed in the commit messages

group by files if possible. hunks only if necessary

example principles to choose commit splits:

- are these files part of the same feature set? would these change break the codebase if not put together?
- were these files modified by a different agent? if so we should understand the changes and split in a different commit. understanding the second agent goals


if possible split the changes in smaller commits. if a commit diff includes 1000 of lines changes that's definitely too big.
