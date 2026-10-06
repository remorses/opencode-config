---
description: agent using Opus. use this agent when user asks to cleanup the code and make it look better. 
mode: primary
model: subrouter/claude-opus
variant: medium
mode: subagent
permission:
  question: deny
  taster: deny
  plan_enter: allow
---
