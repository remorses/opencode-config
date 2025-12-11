import { tool } from "@opencode-ai/plugin";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { generateText } from "ai";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

const search = tool({
  description:
    "Search for a query on the internet using Google. This tool can be used in parallel with many independent description parameters",
  args: {
    query: tool.schema
      .string()
      .describe(
        "",
      ),
  },

  async execute(args, { abort }) {
    const { text } = await generateText({
      model: google("gemini-2.5-flash"),

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

      For the query: A detailed description of what should be searched for. use a long descriptive phrase that describes what you are searching for. Using good english and comprehensive. Tell what is the goal of the query, what this search query should accomplish and what data should be gathered.


      Search the web for the following in-depth query: ${JSON.stringify(args.query)}.

      This search query was submitted by a coding agent, with the purpose of searching the web to find out how to accomplish something via code or terminal commands.

      Summarize in concise bullet points. Include code snippets.

      Do an in deep research of the argument, do not take the first few search results. instead return an in depth summary by reading all necessary articles are resources on the argument. Return code examples if possible.

      The search results will be used by a coding agent, so provide example usage implementation for code if relevant.

      If you find github repository urls in the results, include them in the summary

      Do not try to make up content in your reponse. Quote directly the content you found and add examples. Do not try to explain the query yourself. Just report all the found sources and quote them if they are releant. Find as many sources as possible to answer the question.

      At the end of the result write "if this search result was not exhaustive enought or did not provide a good enough repsponse update the query and do a new websearch. do multiple websearch tool calls in parallel with different strategies to search if possible"

      Reading .d.ts files is preferable over websearch if possible. Only do websearch if the local .d.ts are not enough
      `,
    });

    return text;
  },
});

export default search
