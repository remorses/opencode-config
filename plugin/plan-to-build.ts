// GPT-5 is very good at exploring a code base and creating plans but very bad at actually writing readable code
// Sonnet and Opus are the opposite: very bad at architecture but good at implementing readable and nice code
// this plugin automatically implements plan agent messages using Opus so that you can always use GPT5 Codex in plan mode and have Opus implement the plan autoamtically

import type { Plugin } from "@opencode-ai/plugin";

const BUILD_PROMPT = `
is your plan for an implementation? if yes, implement it. Follow the plan closely. Write simple and readable code.
`;

export const PlanToBuildPlugin: Plugin = async ({ client }) => {
  const sessionsWithErrors = new Set<string>();
  const handledMessageIds = new Set<string>();

  async function handlePlanSessionComplete(sessionId: string) {
    // Skip if session had errors
    if (sessionsWithErrors.has(sessionId)) {
      return;
    }

    let lastPlanMessageId: string | undefined;

    try {
      // Get session messages to check if it was a plan session
      const { data: messages } = await client.session.messages({
        path: { id: sessionId },
      });

      if (!messages || messages.length === 0) {
        return;
      }

      // Check if the last assistant message was in plan mode
      const lastAssistantMessage = messages.findLast(
        (msg) => msg?.info.role === "assistant",
      )?.info;

      if (
        !lastAssistantMessage ||
        lastAssistantMessage.role !== "assistant" ||
        lastAssistantMessage.mode !== "plan"
      ) {
        return;
      }

      lastPlanMessageId = lastAssistantMessage.id;

      if (!lastPlanMessageId) {
        return;
      }

      // Skip if we've already handled this plan message
      if (handledMessageIds.has(lastPlanMessageId)) {
        return;
      }

      handledMessageIds.add(lastPlanMessageId);

      // Submit a new message to continue with build mode using Claude Opus 4.1
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5-20250929",
          },
          parts: [
            {
              type: "text",
              text: BUILD_PROMPT,
            },
          ],
        },
      });
    } catch (error) {
      // Remove from handled set so it could be retried if needed
      if (lastPlanMessageId) {
        handledMessageIds.delete(lastPlanMessageId);
      }
    }
  }

  return {
    async event({ event }) {
      // Track sessions with errors
      if (event.type === "session.error") {
        if (event.properties.sessionID) {
          sessionsWithErrors.add(event.properties.sessionID);
        }
        return;
      }

      // Clear error tracking when session is updated (resumed)
      if (event.type === "session.updated") {
        const sessionId = event.properties.info?.id;
        if (sessionId) {
          sessionsWithErrors.delete(sessionId);
        }
        return;
      }

      // Handle session idle (completion)
      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID;
        if (sessionId) {
          await handlePlanSessionComplete(sessionId);
        }
      }
    },
  };
};
