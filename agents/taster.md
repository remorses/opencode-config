---
description: agent using Opus. use this agent when user asks to cleanup the code and make it look better. 
mode: subagent
model: anthropic/claude-opus-5-5#medium
permissions:
  - { action: "question", resource: "*", effect: deny }
  - { action: "subagent", resource: "taster", effect: deny }
---
