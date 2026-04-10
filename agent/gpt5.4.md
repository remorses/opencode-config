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


DO NOT over engineer. keep code simple. do not care about backwards compatibility too much

DO NOT write useless test. if a test is too brittle or useless (testing obvious things) remove it.
