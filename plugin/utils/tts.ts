import type { PluginInput } from "@opencode-ai/plugin";
import path from "node:path";

type BunShell = PluginInput["$"];

export function getProjectFolder(project?: {
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

export async function isScreenStudioRunning($: BunShell): Promise<boolean> {
  return $`pgrep -x "Screen Studio"`
    .quiet()
    .then(() => true)
    .catch(() => false);
}

export function getCartesiaApiKey(): string | undefined {
  const env = process.env;
  return env?.CARTESIA_API_KEY || env?.CARTESIA || env?.CARTESIA_KEY;
}

export async function synthesizeAndPlay({
  transcript,
  apiKey,
  $,
  outputPath = "/tmp/opencode-tts.wav",
}: {
  transcript: string;
  apiKey: string;
  $: BunShell;
  outputPath?: string;
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

  await $`
    curl -s -X POST https://api.cartesia.ai/tts/bytes \
      -H Cartesia-Version:2024-06-10 \
      -H X-API-Key:${apiKey} \
      -H Content-Type:application/json \
      -d ${payload} \
      -o ${outputPath}
  `.quiet();

  await $`afplay ${outputPath}`.quiet();
}

export async function speak({
  message,
  $,
}: {
  message: string;
  $: BunShell;
}): Promise<void> {
  const screenStudioRunning = await isScreenStudioRunning($);
  if (screenStudioRunning) {
    return;
  }

  const apiKey = getCartesiaApiKey();
  if (!apiKey) {
    await $`say ${message}`.quiet();
    return;
  }

  try {
    await synthesizeAndPlay({ transcript: message, apiKey, $ });
  } catch {
    await $`say ${message}`.quiet();
  }
}
