// Describe images and videos using Gemini vision. Accepts a local file path
// and an optional custom prompt. Videos get timestamp-based narration by default.

import { tool } from '@opencode-ai/plugin'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { generateText } from 'ai'
import { readFile } from 'fs/promises'
import { extname } from 'path'
import dedent from 'string-dedent'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.svg',
  '.ico',
  '.heic',
  '.heif',
  '.avif',
])

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.m4v',
  '.flv',
  '.wmv',
  '.3gp',
  '.ogv',
])

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.m4v': 'video/mp4',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
    '.3gp': 'video/3gpp',
    '.ogv': 'video/ogg',
  }
  return map[ext] || 'application/octet-stream'
}

function buildPrompt(isVideo: boolean, customPrompt?: string): string {
  const base = isVideo
    ? dedent`
      Describe the key events in this video, providing both audio and visual details.
      Include timestamps for salient moments in MM:SS format (e.g. 00:05, 01:15, 12:30).
      Cover visual elements, text, transitions, audio cues, and any notable details.
    `
    : dedent`
      Explain in detail the contents of this image file.
      Describe visual elements, text, colors, layout, objects, people, and any notable details.
    `

  if (customPrompt) {
    return `${base}\n\nAdditional instructions: ${customPrompt}`
  }
  return base
}

const readMedia = tool({
  description: `Describe an image or video file using Gemini vision.

Video files must be under ~15 MB (base64 overhead pushes the 20 MB request limit).
For larger or longer videos, split them first with ffmpeg before calling this tool:
  ffmpeg -i input.mp4 -t 300 -c copy part1.mp4
  ffmpeg -i input.mp4 -ss 300 -t 300 -c copy part2.mp4`,

  args: {
    path: tool.schema
      .string()
      .describe('Absolute path to the image or video file to describe.'),
    prompt: tool.schema
      .string()
      .optional()
      .describe(
        'Optional custom prompt to guide the description. Added on top of the default detailed description prompt.',
      ),
  },

  async execute(args, { abort }) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing.')
    }

    const ext = extname(args.path).toLowerCase()
    const isVideo = VIDEO_EXTENSIONS.has(ext)
    const isImage = IMAGE_EXTENSIONS.has(ext)

    if (!isVideo && !isImage) {
      throw new Error(
        `Unsupported file extension "${ext}". Supported: ${[...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join(', ')}`,
      )
    }

    const fileData = await readFile(args.path)
    const mimeType = getMimeType(ext)
    const textPrompt = buildPrompt(isVideo, args.prompt)

    const google = createGoogleGenerativeAI({ apiKey })

    const result = await generateText({
      model: google('gemini-3.5-flash'),
      messages: [
        {
          role: 'user',
          content: [
            isVideo
              ? { type: 'file' as const, data: fileData, mediaType: mimeType }
              : { type: 'image' as const, image: fileData, mediaType: mimeType },
            { type: 'text', text: textPrompt },
          ],
        },
      ],
      abortSignal: abort,
    })

    return result.text
  },
})

export default readMedia
