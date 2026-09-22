---
description: Build agent using GPT 5 Codex
mode: primary
model: subrouter/gpt-codex
variant: medium
permission:
  question: allow
  plan_enter: allow
  task:
    "*": allow
    oracle: deny
    image-understanding: deny
---
