---
description: agent using Opus. use this agent when user asks to cleanup the code and make it look better. 
mode: primary
model: anthropic/claude-opus-4-6
variant: medium
mode: subagent
permission:
  question: allow
  taster: deny
  plan_enter: allow
---
