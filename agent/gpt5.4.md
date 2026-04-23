---
description: Build agent using GPT 5 Codex
mode: primary
model: openai/gpt-5.4
variant: high
permission:
  question: allow
  plan_enter: allow
  task:
    "*": allow
    oracle: deny
    image-understanding: deny
---


DO NOT over engineer. keep code simple. do not care about backwards compatibility

DO NOT write useless tests. if a test is too brittle or useless (testing obvious things) remove it, do not add it. 

if you are testing an external service, you must not redefine a fake service to use in the tests. this will be useless and test nothing. instead you can add test files that depend on api keys and credentials in the environment (and skipped otherwise) with inline snapshots to validate your assumptions on the third party service. like to see error responses, status codes, response shapes.

your changes should add the feature or fix the issue with minimal diffs. before starting editing code think of the codebase architecture and where is the best way to do the change. if needed we could need to refactor. 

if a bug fix diff ends up to only have additions in the code, it's a code smell. bug fixes usually have symmetric added and deleted lines. if you just added code to fix an issue it means you are just patching things up with slop. rethink your approach
