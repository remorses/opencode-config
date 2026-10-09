// Custom tools: googlesearch, describe-media, read-video.
// Auto-discovered by OpenCode V2 from ~/.config/opencode/plugins/.
// codemode: false exposes each tool directly to the model, not only inside `execute`.

import { Plugin } from '@opencode/plugin'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { generateText } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import dedent from 'string-dedent'

function geminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing.')
  return apiKey
}

// googlesearch

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  error?: { message?: string }
}

function buildSearchPrompt(query: string) {
  return dedent`
    You are a research assistant for a coding agent. Search the web thoroughly and return findings.

    **Query:** ${JSON.stringify(query)}

    **Instructions:**
    1. Search multiple times with varied terms to get comprehensive coverage
    2. Read and synthesize the most relevant results
    3. Structure your response with:
       - Key findings as concise bullet points
       - Code snippets (properly formatted) when available
       - Links to official docs, GitHub repos, and authoritative sources
       - Version numbers and dates when relevant

    **Important:**
    - Quote directly from sources rather than paraphrasing
    - Do not fabricate information - only report what you found
    - Be concise
    - Prioritize official documentation and well-maintained repos
    - Include URLs for all referenced resources
  `
}

async function runGroundedGoogleSearch(query: string, signal: AbortSignal) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(geminiApiKey())}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildSearchPrompt(query) }] }],
        tools: [{ googleSearch: {} }],
      }),
      signal,
    },
  )

  const raw = await response.text()
  if (!response.ok) throw new Error(`Google search request failed (${response.status}): ${raw}`)

  let parsed: GeminiResponse
  try {
    parsed = JSON.parse(raw) as GeminiResponse
  } catch {
    throw new Error('Google search response was not valid JSON.')
  }

  const text =
    parsed.candidates?.[0]?.content?.parts
      ?.map((part) => part.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join('\n\n') ?? ''
  if (text) return text
  if (parsed.error?.message) throw new Error(parsed.error.message)
  throw new Error('Google search response did not include text output.')
}

const GOOGLESEARCH_DESCRIPTION = dedent`
  Search the web using Google via Gemini. Returns in-depth research summaries with code examples, documentation links, and GitHub repos.

  **When to use:**
  - Current events, recent releases, or time-sensitive information
  - API usage patterns, library documentation, or framework guides
  - Troubleshooting errors or finding solutions to specific problems
  - Finding GitHub repos, npm packages, or official docs

  **When NOT to use (prefer alternatives):**
  - For library internals: use lib-investigator agent or fetch source with \`opensrc path <pkg>\`
  - For API signatures: read local .d.ts files first
  - For code patterns: use codesearch tool and gh search cli

  **Tips:**
  - Call multiple times in parallel with different query angles for faster, broader coverage
  - Use natural language descriptions, not keyword searches
  - Include context about your goal so results are more targeted
`

// describe-media

const MIME_TYPES: Record<string, string> = {
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

function buildDescribePrompt(isVideo: boolean, customPrompt?: string) {
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
  return customPrompt ? `${base}\n\nAdditional instructions: ${customPrompt}` : base
}

async function describeMedia(filePath: string, customPrompt: string | undefined, signal: AbortSignal) {
  const ext = path.extname(filePath).toLowerCase()
  const mediaType = MIME_TYPES[ext]
  if (!mediaType) throw new Error(`Unsupported file extension "${ext}". Supported: ${Object.keys(MIME_TYPES).join(', ')}`)
  const isVideo = mediaType.startsWith('video/')

  const data = await fs.readFile(filePath)
  const google = createGoogleGenerativeAI({ apiKey: geminiApiKey() })
  const result = await generateText({
    model: google('gemini-3.5-flash'),
    messages: [
      {
        role: 'user',
        content: [
          isVideo ? { type: 'file', data, mediaType } : { type: 'image', image: data, mediaType },
          { type: 'text', text: buildDescribePrompt(isVideo, customPrompt) },
        ],
      },
    ],
    abortSignal: signal,
  })
  return result.text
}

const DESCRIBE_MEDIA_DESCRIPTION = dedent`
  Describe an image or video file using Gemini vision.

  Video files must be under ~15 MB (base64 overhead pushes the 20 MB request limit).
  For larger or longer videos, split them first with ffmpeg before calling this tool:
    ffmpeg -i input.mp4 -t 300 -c copy part1.mp4
    ffmpeg -i input.mp4 -ss 300 -t 300 -c copy part2.mp4
`

// read-video

const VIDEO_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

const MAX_VIDEO_BYTES = 20 * 1024 * 1024

async function loadVideo(filePath: string, signal: AbortSignal) {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    const res = await fetch(filePath, { signal })
    if (!res.ok) throw new Error(`Failed to fetch video: ${res.status} ${res.statusText}`)
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      name: new URL(filePath).pathname.split('/').pop() || 'video.mp4',
      mime: res.headers.get('content-type') || 'video/mp4',
    }
  }
  const resolved = path.resolve(filePath)
  const mime = VIDEO_MIME_TYPES[path.extname(resolved).toLowerCase()]
  if (!mime) {
    throw new Error(`Unsupported video format: ${path.extname(resolved)}. Supported: ${Object.keys(VIDEO_MIME_TYPES).join(', ')}`)
  }
  const bytes = await fs.readFile(resolved).catch(() => {
    throw new Error(`Video file not found: ${resolved}`)
  })
  return { bytes, name: path.basename(resolved), mime }
}

export default Plugin.define({
  id: 'morse.custom-tools',
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'googlesearch',
        description: GOOGLESEARCH_DESCRIPTION,
        input: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                "A detailed natural language description of what to search for. Include: what you're trying to accomplish, relevant technologies/frameworks, and what kind of information you need (docs, examples, repos, etc.).",
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { query } = input as { query: string }
          try {
            return { content: await runGroundedGoogleSearch(query, context.signal) }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              content: `**Google Search failed.** Use alternatives now (WebSearch, gh search code, or manual lookup) to complete the task. At the end of the session, tell the user Google search was broken and why.\n\nError: ${message}`,
            }
          }
        },
      })

      editor.add({
        name: 'describe-media',
        description: DESCRIBE_MEDIA_DESCRIPTION,
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the image or video file to describe.' },
            prompt: {
              type: 'string',
              description:
                'Optional custom prompt to guide the description. Added on top of the default detailed description prompt.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const args = input as { path: string; prompt?: string }
          return { content: await describeMedia(args.path, args.prompt, context.signal) }
        },
      })

      editor.add({
        name: 'read-video',
        description:
          'Read a video or audio file (mp4, webm, mov, mp3, wav) from a local path or URL and add it directly into model context window for analysis. Only works with Google Gemini models; non-Gemini models will get an error from the provider. If you are not using a Gemini model, use a Gemini subagent or the describe-media tool instead.',
        input: {
          type: 'object',
          properties: { filePath: { type: 'string', description: 'Absolute file path or URL to the video' } },
          required: ['filePath'],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { bytes, name, mime } = await loadVideo((input as { filePath: string }).filePath, context.signal)
          if (bytes.length > MAX_VIDEO_BYTES) {
            throw new Error(
              `Video exceeds 20 MB limit (${(bytes.length / 1024 / 1024).toFixed(1)} MB). Trim it with: ffmpeg -i input.mp4 -t 30 -c copy trimmed.mp4`,
            )
          }
          return {
            content: [
              { type: 'text', text: `Video read successfully: ${name} (${(bytes.length / 1024).toFixed(0)} KB, ${mime})` },
              { type: 'file', uri: `data:${mime};base64,${bytes.toString('base64')}`, mime, name },
            ],
          }
        },
      })
    })
  },
})
