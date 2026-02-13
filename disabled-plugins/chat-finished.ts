// Plugin that announces when chat sessions complete or error via TTS.
// Waits 2s before speaking to avoid interrupting resumed sessions.

import type { Plugin } from "@opencode-ai/plugin";
import { getProjectFolder, speak } from "../plugins/utils/tts";

const MAX_TITLE_WORDS = 5;

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false;

function formatTitle(title?: string): string {
  if (!title) {
    return "";
  }

  if (title.trim().toLowerCase().startsWith("new session")) {
    return "";
  }
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  return words.slice(0, MAX_TITLE_WORDS).join(" ");
}

const ChatFinishedPlugin: Plugin = async ({ project, client, $ }) => {
  const sessionsWithErrors = new Map<string, { ignore: boolean }>();

  async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function handleSessionIdle(sessionId?: string) {
    if (!sessionId) {
      return;
    }

    // Wait 2 seconds before processing
    await sleep(2000);

    // Re-fetch session to check if it's back in progress
    const { data: session } = await client.session.get({
      path: { id: sessionId },
    });
    if (!session) {
      return;
    }

    if (
      // @ts-ignore - state field may not be in type definitions yet
      session.state?.status === "progress" &&
      // @ts-ignore - state field may not be in type definitions yet
      session.state?.progress?.status === "running"
    ) {
      // Session is back in progress, skip notification
      return;
    }

    const folder = getProjectFolder(project);
    const formattedTitle = formatTitle(session.title);

    const errorInfo = sessionsWithErrors.get(sessionId);
    if (errorInfo?.ignore) {
      return;
    }

    const message = sessionsWithErrors.has(sessionId)
      ? `errored ${folder} ${formattedTitle}`.trim()
      : `finished ${folder} ${formattedTitle}`.trim();

    if (!message) {
      return;
    }

    await speak({ message, $ });
  }

  return {
    async event({ event }) {
      if (event.type === "session.error") {
        if (event.properties.sessionID) {
          const isAbortError =
            event.properties.error?.name === "MessageAbortedError";
          sessionsWithErrors.set(event.properties.sessionID, {
            ignore: isAbortError,
          });
          if (isAbortError) {
            return;
          }
        }
        return;
      }

      if (event.type === "session.updated") {
        const sessionId = event.properties.info.id;
        if (sessionId) {
          sessionsWithErrors.delete(sessionId);
        }
        return;
      }

      if (event.type !== "session.idle") {
        return;
      }
      await handleSessionIdle(event.properties.sessionID);
    },
  };
};
