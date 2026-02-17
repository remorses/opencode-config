/**
 * Abort plugin - interrupts the current session when user sends message "x"
 *
 * Uses the chat.message hook to intercept user messages before they're sent
 * to the model. When the user types just "x", aborts the running session.
 */

import type { Plugin } from "@opencode-ai/plugin";

export const AbortOnXPlugin: Plugin = async ({ client }) => {
  return {
    "chat.message": async (input, output) => {
      // Extract text from message parts
      const text = output.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => (p as { text: string }).text.trim())
        .join("")
        .trim();

      // Check if the message is exactly "x" (case-insensitive)
      if (text.toLowerCase() !== "x") return;

      // Clear parts so "x" isn't sent to the LLM
      output.parts.length = 0;

      try {
        await client.session.abort({ path: { id: input.sessionID } });
      } catch (err) {
        // Session might not be running or already aborted
      }
    },
  };
};
