
// TTS utility functions using Cartesia API or macOS say command.
// Provides speak(), synthesizeAndPlay(), and voice configuration.

import type { PluginInput } from "@opencode-ai/plugin";
import path from "node:path";

type BunShell = PluginInput["$"];

// Cartesia voice IDs
export const VOICES = {
  // Default voice for chat notifications
  default: "7cb7e4c0-079a-4646-be33-e4447a1dfcde",
  // Female voice for permission requests (from Cartesia examples)
  permission: "a0e99841-438c-4a64-b679-ae501e7d6091",
} as const;

export type VoiceId = (typeof VOICES)[keyof typeof VOICES] | string;

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
  voice = VOICES.default,
  outputPath = "/tmp/opencode-tts.wav",
}: {
  transcript: string;
  apiKey: string;
  $: BunShell;
  voice?: VoiceId;
  outputPath?: string;
}) {
  const voiceId = voice;
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

export const OUTPUT_PATHS = {
  default: "/tmp/opencode-tts.wav",
  permission: "/tmp/opencode-permission.wav",
} as const;

export async function speak({
  message,
  $,
  voice = VOICES.default,
  outputPath = OUTPUT_PATHS.default,
}: {
  message: string;
  $: BunShell;
  voice?: VoiceId;
  outputPath?: string;
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
    await synthesizeAndPlay({ transcript: message, apiKey, $, voice, outputPath });
  } catch {
    await $`say ${message}`.quiet();
  }
}
