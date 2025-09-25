import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";

const MAX_TITLE_WORDS = 5;

function getProjectFolder(project?: {
  directory?: string;
  worktree?: string;
}): string {
  if (project?.directory) {
    return path.basename(project.directory);
  }
  if (project?.worktree) {
    return path.basename(project.worktree);
  }
  return "project";
}

function formatTitle(title?: string): string {
  if (!title) {
    return "session";
  }
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "session";
  }
  return words.slice(0, MAX_TITLE_WORDS).join(" ");
}

async function synthesizeAndPlay({
  transcript,
  apiKey,
  exec,
}: {
  transcript: string;
  apiKey: string;
  exec: (
    strings: TemplateStringsArray,
    ...values: Array<string>
  ) => Promise<unknown>;
}) {
  const voiceId = "7cb7e4c0-079a-4646-be33-e4447a1dfcde";
  const payload = JSON.stringify({
    model_id: "sonic-turbo",
    transcript,
    voice: {
      mode: "id",
      id: voiceId,
    },
    output_format: {
      container: "wav",
      encoding: "pcm_f32le",
      sample_rate: 44100,
    },
    language: "en",
    speed: "normal",
  });

  const responsePath = "/tmp/opencode-cartesia.wav";

  await exec`
    curl -s -X POST https://api.cartesia.ai/tts/bytes \
      -H Cartesia-Version:2024-06-10 \
      -H X-API-Key:${apiKey} \
      -H Content-Type:application/json \
      -d ${payload} \
      -o ${responsePath}
  `;

  await exec`
    afplay ${responsePath}
  `;
}

export const ChatFinishedPlugin: Plugin = async ({
  project,
  client,
  $,

}) => {
  const sessionsWithErrors = new Set<string>();

  async function handleSessionIdle(sessionId?: string) {
    if (!sessionId) {
      return;
    }

    const env = process.env
    const { data: session } = await client.session.get({
      path: { id: sessionId },
    });
    if (!session) {
      return;
    }

    const folder = getProjectFolder(project);
    const formattedTitle = formatTitle(session.title);

    const message = sessionsWithErrors.has(sessionId)
      ? `errored ${folder} ${formattedTitle}`.trim()
      : `finisehd ${folder} ${formattedTitle}`.trim();

    if (!message) {
      return;
    }

    const apiKey = env?.CARTESIA_API_KEY || env?.CARTESIA || env?.CARTESIA_KEY;
    if (!apiKey) {
      await $`say ${message}`;
      return;
    }

    try {
      await synthesizeAndPlay({ transcript: message, apiKey, exec: $ });
    } catch (error) {
      console.error(error);
      await $`say ${message}`;
    }
  }

  return {
    async event({ event,  }) {
      if (event.type === "session.error") {
        if (event.properties.sessionID) {
          sessionsWithErrors.add(event.properties.sessionID);
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
