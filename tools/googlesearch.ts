// Web search tool using Gemini with Google Search grounding.
// Performs real-time searches and returns structured summaries with code examples,
// documentation links, and GitHub repos. Optimized for coding agent queries.

import { tool } from "@opencode-ai/plugin";
import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProviderOptions,
} from "@ai-sdk/google";
import { generateText } from "ai";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

const googlesearch = tool({
  description: `Search the web using Google via Gemini. Returns in-depth research summaries with code examples, documentation links, and GitHub repos.

**When to use:**
- Current events, recent releases, or time-sensitive information
- API usage patterns, library documentation, or framework guides
- Troubleshooting errors or finding solutions to specific problems
- Finding GitHub repos, npm packages, or official docs

**When NOT to use (prefer alternatives):**
- For library internals: use lib-investigator agent or download source to ./opensrc
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
    const { text } = await generateText({
      model: google("gemini-2.5-flash-lite"),
      providerOptions: {
        google: {
          // thinkingConfig: {
          //   thinkingLevel: "low",
          // },
        } satisfies GoogleGenerativeAIProviderOptions,
      },
      abortSignal: abort,
      tools: {
        google_search: google.tools.googleSearch({}),
      },
      stopWhen: () => false,
      prompt: `You are a research assistant for a coding agent. Search the web thoroughly and return findings.

**Query:** ${JSON.stringify(args.query)}

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
- Include URLs for all referenced resources`,
    });

    return text;
  },
});

export default googlesearch;
