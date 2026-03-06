---
description: Build agent using GPT 5 Codex
mode: primary
model: openai/gpt-5.4
variant: medium
permission:
  question: allow
  plan_enter: allow
  task:
    "*": allow
    explore: deny
    oracle: deny
---
