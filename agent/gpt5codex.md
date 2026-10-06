---
description: Build agent using GPT 6.1 Sol
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
