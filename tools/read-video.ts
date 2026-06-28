// Read a video file (mp4, webm, mov) into context as an inline attachment.
// Only works with Google Gemini models. Other models should use a Gemini
// subagent or the describe-media tool instead.

import { tool } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"

const MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
}

const MAX_BYTES = 20 * 1024 * 1024

export default tool({
  description: `Read a video or audio file (mp4, webm, mov, mp3, wav) from a local path or URL and add it directly into model context window for analysis. Only works with Google Gemini models; non-Gemini models will get an error from the provider. If you are not using a Gemini model, use a Gemini subagent or the describe-media tool instead.`,
  args: {
    filePath: tool.schema.string().describe("Absolute file path or URL to the video"),
  },
  async execute(args, ctx) {
    const isUrl = args.filePath.startsWith("http://") || args.filePath.startsWith("https://")
    let bytes: Buffer
    let name: string
    let mime: string

    if (isUrl) {
      const res = await fetch(args.filePath, { signal: ctx.abort })
      if (!res.ok) throw new Error(`Failed to fetch video: ${res.status} ${res.statusText}`)
      bytes = Buffer.from(await res.arrayBuffer())
      name = new URL(args.filePath).pathname.split("/").pop() || "video.mp4"
      mime = res.headers.get("content-type") || "video/mp4"
    } else {
      const resolved = path.resolve(args.filePath)
      if (!fs.existsSync(resolved)) throw new Error(`Video file not found: ${resolved}`)
      bytes = fs.readFileSync(resolved)
      name = path.basename(resolved)
      const ext = path.extname(resolved).toLowerCase()
      if (!MIME_MAP[ext]) throw new Error(`Unsupported video format: ${ext}. Supported: ${Object.keys(MIME_MAP).join(", ")}`)
      mime = MIME_MAP[ext]
    }

    if (bytes.length > MAX_BYTES) {
      throw new Error(`Video exceeds 20 MB limit (${(bytes.length / 1024 / 1024).toFixed(1)} MB). Trim it with: ffmpeg -i input.mp4 -t 30 -c copy trimmed.mp4`)
    }

    return {
      output: `Video read successfully: ${name} (${(bytes.length / 1024).toFixed(0)} KB, ${mime})`,
      attachments: [{ type: "file" as const, mime, url: `data:${mime};base64,${bytes.toString("base64")}`, filename: name }],
    }
  },
})
