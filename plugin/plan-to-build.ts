import type { Plugin } from "@opencode-ai/plugin";

export const PlanToBuildPlugin: Plugin = async ({ client }) => {
  const sessionsWithErrors = new Set<string>();
  const processedSessions = new Set<string>();

  async function handlePlanSessionComplete(sessionId: string) {
    // Skip if we've already processed this session
    if (processedSessions.has(sessionId)) {
      return;
    }

    // Skip if session had errors
    if (sessionsWithErrors.has(sessionId)) {
      return;
    }

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

      // Mark as processed to avoid duplicate submissions
      processedSessions.add(sessionId);

      // Submit a new message to continue with build mode using Claude Opus 4.1
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-20250514",
          },
          parts: [
            {
              type: "text",
              text: "is your plan for an implementation? if yes, implement it. could the plan be implemented in a more elegant and simpler way? if yes update it. is the plan finished? if not complete it, thinking of what else needs to be thought out with all steps and details that will be passed to the implementer agent.",
            },
          ],
        },
      });
    } catch (error) {
      // Remove from processed set so it could be retried if needed
      processedSessions.delete(sessionId);
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
