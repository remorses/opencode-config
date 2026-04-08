import type { Plugin } from "@opencode-ai/plugin";
import path from "path";
import os from "os";
import fs from "fs/promises";

const systemPromptDriftPlugin: Plugin = async ({ client, directory }) => {
  const dataDir = path.resolve(os.homedir(), ".opencode-prompts");

  // Create data directory if it doesn't exist
  await fs.mkdir(dataDir, { recursive: true });

  return {
    "chat.message": async (input) => {
      const sessionId = input.sessionID;
      if (!sessionId) {
        return;
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID;
      if (!sessionId) {
        return;
      }

      const filePath = path.join(dataDir, `${sessionId}.md`);
      await fs.writeFile(filePath, output.system, "utf-8");
    },
  };
};

// export { systemPromptDriftPlugin };
