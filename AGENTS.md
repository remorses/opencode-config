to list, search and read files on github use gitchamber. before using it ALWAYS do `curl -fs gitchamber.com` to see its usage instructions.

never commit anything unless asked by the user precisely

always use kebab case for new filenames. never use uppercase letters in filenames

NEVER use mocks in tests

if you open PRs or issues with gh cli first check what is the correct commit, title and body format for the pr or issue. if there is not any don't use headings in the body (it looks like AI slop)

after creating a pr always watch for ci to complete successfully using command like

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


.toMatchInlineSnapshot is the preferred way to write tests. leave them empty the first time, update them with -u. check git diff for the test file every time you update them with -u
