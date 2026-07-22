---
name: tommy-x-posts
description: >
  Write and publish X posts for Tommy (@__morse) in his voice. Use when asked to
  draft, plan, or post a tweet or long-form X post, especially product/launch
  posts for his projects. Covers voice rules, structure, fact gathering from
  real code, and publishing via the akarso CLI.
---

# Writing X posts for Tommy

## Workflow

1. **Gather real facts first.** Read the actual project code before drafting.
   Get concrete numbers: file line counts, feature names, limits, as they exist
   in code. Never use numbers from memory or from the user's rough notes
   without verifying against the source. If a note is wrong, use the real
   number and tell the user you corrected it.
2. **Study his recent tweets** with the `searching-x` skill
   (`from:__morse -filter:replies`) to calibrate the voice against what he
   actually posts, not against these rules alone.
3. **Draft in chat, never post immediately.** Show a long post draft + a short
   tweet draft + 2-3 alternative hooks. Iterate until he explicitly says post.
4. **Publish with akarso** from `~/.kimaki/projects/akarso/cli`:

   ```bash
   pnpm akarso posts create --text "$(cat /tmp/post.txt)" --platforms x --publish-now
   ```

   Write the text to a temp file first (heredoc), never inline multiline text
   in the flag. After posting, poll `posts get <id>` until `status: POSTED`
   and share the permalink.

## Voice rules

- lowercase everywhere, except **"I" stays capitalized** and proper nouns keep
  their casing; product names he mocks or compares against can stay lowercase
- short plain declarative sentences. flat statements, not punchlines
- **no mic drops.** every paragraph having a clever closer reads as AI. one
  plain fact per paragraph is enough
- no "→" arrow chains, no em dashes, no rhetorical questions, no "here's the
  thing", no listicles with bold labels
- no hashtags, no emojis
- occasional mild swearing is fine when genuinely excited, don't force it
- commands in monospace unicode, e.g. 𝚗𝚙𝚡 𝚜𝚘𝚖𝚎𝚝𝚑𝚒𝚗𝚐
- launch posts open with "introducing <name>" then one line saying what it is,
  often "for agents & humans"

## Structure (long post)

- first line is the hook, short and plain: "why <project>" beats a clever
  thesis sentence
- **empty line between every paragraph**, no exceptions
- each paragraph = one reason/feature, 1-3 sentences, plain
- agent-related angles come first — agents as users of tools is his recurring
  thesis
- end with the install command in monospace unicode, then the github/site link
  as the last line, plain url

## Themes he cares about

- agents are the real users of frameworks and tools now; tools need feedback
  loops (type checking, tests) so agents fix their own mistakes without a human
- lightweight over magic: small codebases, few dependencies, tools you can read
  in one sitting, running many instances in parallel worktrees
- no hidden framework magic or implicit caching; you own your code
- deploy anywhere, no platform lock-in
- self-service software, anti enterprise bloat

## What kills a draft

If he says "sounds like AI bs", the fix is always the same: remove punchlines,
remove parallel rhetorical structure, remove manufactured hooks, flatten every
sentence into someone plainly explaining what they built.
