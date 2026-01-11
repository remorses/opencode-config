
// Custom tool for web search using Gemini with Google Search grounding.
// Returns in-depth research summaries with code examples.

import { tool } from "@opencode-ai/plugin";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { generateText } from "ai";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

const search = tool({
  description:
    `
    For the query: A detailed description of what should be searched for. use a long descriptive phrase that describes what you are searching for. Using good english and comprehensive. Tell what is the goal of the query, what this search query should accomplish and what data should be gathered.

    Search for a query on the internet using Google. This tool can be used in parallel with many independent description parameters

    Reading .d.ts files is preferable over google if possible. Only do google searches if the local .d.ts are not enough. Or you cannot directly download relevant source code repo into ./tmp and start a task to explore and answer questions
    `,
  args: {
    query: tool.schema
      .string()
      .describe(
        "",
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
      prompt: `

      Search the web for the following in-depth query: ${JSON.stringify(args.query)}.

      This search query was submitted by a coding agent, with the purpose of searching the web to find out how to accomplish something via code or terminal commands.

      Summarize in concise bullet points. Include code snippets.

      Do an in deep research of the argument, searching multiple times. return an in depth summary by reading all necessary results are resources on the argument. Return code examples if possible.

      The search results will be used by a coding agent, so mention docs urls and github repos if present.

      Do not  make up content in your response. Quote directly the content you found and add examples. Do not try to explain the query yourself. Just report all the found sources and quote them if they are relevant.

      At the end of the result write "if this search result was not exhaustive enough or did not provide a good enough response update the query and do a new google search. multiple calls in parallel with different strategies to search faster"

      `,
    });

    return text;
  },
});

export default search
