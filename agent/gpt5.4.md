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
