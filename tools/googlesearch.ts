// Web search tool using Gemini with Google Search grounding.
// Performs real-time searches and returns structured summaries with code examples,
// documentation links, and GitHub repos. Optimized for coding agent queries.

import { tool } from "@opencode-ai/plugin";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

function buildPrompt(query: string) {
  return `You are a research assistant for a coding agent. Search the web thoroughly and return findings.

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
- Include URLs for all referenced resources`;
}

async function runGroundedGoogleSearch(query: string, abort: AbortSignal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(query) }] }],
        tools: [{ googleSearch: {} }],
      }),
      signal: abort,
    },
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Google search request failed (${response.status}): ${raw}`);
  }

  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(raw) as GeminiResponse;
  } catch {
    throw new Error("Google search response was not valid JSON.");
  }

  const text =
    parsed.candidates?.[0]?.content?.parts
      ?.map((part) => part.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join("\n\n") ?? "";

  if (text) {
    return text;
  }

  if (parsed.error?.message) {
    throw new Error(parsed.error.message);
  }

  throw new Error("Google search response did not include text output.");
}

const googlesearch = tool({
  description: `Search the web using Google via Gemini. Returns in-depth research summaries with code examples, documentation links, and GitHub repos.

**When to use:**
- Current events, recent releases, or time-sensitive information
- API usage patterns, library documentation, or framework guides
- Troubleshooting errors or finding solutions to specific problems
- Finding GitHub repos, npm packages, or official docs

**When NOT to use (prefer alternatives):**
- For library internals: use lib-investigator agent or download source to \`node_modules/.gitchamber\`
- For API signatures: read local .d.ts files first
- For code patterns: use codesearch tool and gh search cli

**Tips:**
- Call multiple times in parallel with different query angles for faster, broader coverage
- Use natural language descriptions, not keyword searches
- Include context about your goal so results are more targeted`,

  args: {
    query: tool.schema
      .string()
      .describe(
        "A detailed natural language description of what to search for. Include: what you're trying to accomplish, relevant technologies/frameworks, and what kind of information you need (docs, examples, repos, etc.).",
      ),
  },

  async execute(args, { abort }) {
    return runGroundedGoogleSearch(args.query, abort);
  },
});

export default googlesearch;
