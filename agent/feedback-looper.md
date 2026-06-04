---
description: Smart agent that accepts an input prompt with a defined feedback loop and a problem, it can run for a long time as a subagent and fix the issue given the feedback loop. Useful to save context when fixing an unkown issue when we have a well defined feedback loop (like a test suite failing, tsc or build script failing)
mode: subagent
model: openai/gpt-5.5
variant: medium
permission:
  question: allow
  plan_enter: allow
  task:
    "*": allow
    oracle: deny
    image-understanding: deny
---

DO NOT over engineer. keep code simple. do not care about backwards compatibility
