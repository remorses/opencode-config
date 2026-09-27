---
name: gh-search
description: >
  Find real working examples of an API, library, or code pattern on GitHub with
  `gh search code` and `gh search repos`, then read the best (most starred)
  implementations. ALWAYS load this skill before guessing how an unfamiliar API,
  library option, config key, or language feature is used, when docs are thin,
  or when an implementation keeps failing. Real code from credible repos beats
  guessing from memory and prevents hallucinated APIs.
---

# gh-search

Search GitHub for **concrete** code before guessing. Search for exact API names, method names, and small string snippets that must appear in a working example.

## Workflow

1. **Search code** for the exact method or pattern.
2. **Collect repo names** from promising hits.
3. **Rank repos** by stars and credibility.
4. **Read the best few** examples in full, not just the first random hit.
5. **Report** repo URLs and file paths of the best examples so they are easy to inspect later.

## 1. Search code

Combine several clues from the pattern. More clues means fewer, better hits.

```bash
# one concrete API
gh search code 'std.process.Child.init "stdout_behavior = .Pipe" language:Zig' --limit 30

# bigger pattern with multiple clues
gh search code 'std.process.Child.init "stdout_behavior = .Pipe" "stderr_behavior = .Pipe" "std.Thread.spawn" language:Zig' --limit 30

# restrict by filename, extension, owner, or repo
gh search code 'minimumReleaseAge' --filename pnpm-workspace.yaml
gh search code 'createTaggedError' --extension ts --owner remorses
gh search code 'ThreadsafeFunction' --repo napi-rs/napi-rs
```

Qualifiers work inline too: `language:go`, `path:src`, `filename:package.json`. Quote exact strings with double quotes inside the single-quoted query.

> `gh search code` uses GitHub's legacy code search API. No regex. Results can differ from github.com. If nothing matches, drop a clue and retry.

## 2. Collect repos from hits

```bash
gh search code 'napi::bindgen_prelude "ThreadsafeFunction" language:Rust' --limit 50 \
  --json repository,path,url \
  --jq '.[] | "\(.repository.nameWithOwner)\t\(.path)"' | sort -u
```

## 3. Rank by stars

Code search JSON has no star count. Look it up per repo:

```bash
for r in owner1/repo1 owner2/repo2; do
  gh repo view "$r" --json nameWithOwner,stargazerCount --jq '"\(.stargazerCount)\t\(.nameWithOwner)"'
done | sort -rn
```

Or search repos by topic directly, sorted by stars:

```bash
gh search repos 'command runner stdout stderr streaming zig' --sort stars --limit 30 \
  --json fullName,stargazersCount,description,url
```

## 4. Read the best examples

Read whole files, not only the matching line. For deep reads, fetch the repo source locally:

```bash
opensrc path owner/repo          # prints cached local path
gh api repos/owner/repo/contents/path/to/file.ts --jq .content | base64 -d
```

Prefer `opensrc path` over cloning into tmp.

## 5. Report

Always include clickable URLs, for example:

- https://github.com/owner/repo/blob/main/src/file.ts (1.2k stars): uses X with Y option
