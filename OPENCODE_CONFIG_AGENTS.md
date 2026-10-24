# opencode config repo

Loaded only for sessions inside `~/.config/opencode` (via `instructions` in `opencode.json`, resolved relative to the session's project).

## this repo is public

This repo is **public** on GitHub: https://github.com/remorses/opencode-config. Anyone can read every tracked file and commit.

Never put private info in tracked files here: no secrets, tokens, emails, phone numbers, account ids, personal data, client names, or private project details.

Put private content in private submodules instead:

- **private skills**: `private-skills/` (submodule of `remorses/private-skills`). Add `repo: remorses/private-skills` in frontmatter.
- **other private files**: add a new private submodule, or gitignore the file (like `MEMORY.md`, `service-local.json`).

Before committing, check the diff for private info.
