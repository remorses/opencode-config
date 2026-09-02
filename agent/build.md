---
description: The default build agent. Routes through subrouter/build so grok, GPT, opus 4.6, then GLM flash take over when a subscription dies.
mode: primary
model: subrouter/build
permission:
  question: allow
  doom_loop: allow
  plan_enter: allow
---
