import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const PRUNED_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information no longer needed]";

export const PrunePlugin: Plugin = async ({ client }) => {

  // Track pruned tool callIDs per session
  const prunedToolIds = new Map<string, Set<string>>();

  const getPrunedSet = (sessionID: string): Set<string> => {
    let set = prunedToolIds.get(sessionID);
    if (!set) {
      set = new Set();
      prunedToolIds.set(sessionID, set);
    }
    return set;
  };

  return {
    // Transform messages before sending to LLM - replace pruned outputs
    "experimental.chat.messages.transform": async (
      _input: {},
      output: { messages: Array<{ info: any; parts: any[] }> },
    ) => {
      for (const msg of output.messages) {
        const sessionID = msg.parts[0]?.sessionID;
        if (!sessionID) continue;

        const pruned = prunedToolIds.get(sessionID);
        if (!pruned || pruned.size === 0) continue;

        for (const part of msg.parts) {
          if (part.type !== "tool") continue;
          if (!pruned.has(part.callID)) continue;

          // Replace output with placeholder
          if (part.state?.status === "completed" && part.state.output) {
            part.state.output = PRUNED_OUTPUT_REPLACEMENT;
          }
        }
      }
    },

    tool: {
      prune: tool({
        description:
          "Aggressively prune tool calls from context to keep the context window small. Call this after completing a task to remove ALL tool outputs that are no longer needed for future work. Prioritize removing: 1) Large read/glob/grep outputs from files you've already processed, 2) Failed or superseded tool calls, 3) Any exploration/search that led to dead ends. Be aggressive - if you don't need the output for your next steps, prune it. The outputs will be replaced with small placeholders.",

        args: {
          filters: tool.schema
            .array(tool.schema.string())
            .describe(
              'Array of filters to match tool calls. Format: "toolName:key=value,key2=value2" e.g. "read:filePath=/foo/bar.ts" or "glob:pattern=**/*.ts"',
            ),
        },

        async execute(args, ctx) {
          // Parse filter strings into {tool, params} objects
          const parsedFilters = args.filters.map((f) => {
            const colonIdx = f.indexOf(":");
            if (colonIdx === -1) {
              return { tool: f, params: {} };
            }
            const toolName = f.slice(0, colonIdx);
            const paramsStr = f.slice(colonIdx + 1);
            const params: Record<string, unknown> = {};
            for (const pair of paramsStr.split(",")) {
              const eqIdx = pair.indexOf("=");
              if (eqIdx !== -1) {
                params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
              }
            }
            return { tool: toolName, params };
          });

          // Fetch messages to find matching tool parts
          const messagesRes = await client.session.messages({
            path: { id: ctx.sessionID },
          });
          if (!messagesRes.data) {
            return JSON.stringify({
              pruned: 0,
              errors: ["Failed to fetch messages"],
            });
          }

          // Build list of tool parts with their callIDs
          const toolParts: Array<{
            callID: string;
            tool: string;
            input: Record<string, unknown>;
            outputLength: number;
          }> = [];

          for (const msg of messagesRes.data) {
            for (const part of msg.parts) {
              if (part.type === "tool") {
                const state = part.state as {
                  input?: Record<string, unknown>;
                  output?: string;
                };
                toolParts.push({
                  callID: part.callID,
                  tool: part.tool,
                  input: state.input ?? {},
                  outputLength: state.output?.length ?? 0,
                });
              }
            }
          }

          const prunedSet = getPrunedSet(ctx.sessionID);
          const errors: string[] = [];
          let pruned = 0;
          let charsSaved = 0;

          for (const filter of parsedFilters) {
            const matches = toolParts.filter((p) => {
              if (p.tool !== filter.tool) return false;
              for (const [key, value] of Object.entries(filter.params)) {
                if (JSON.stringify(p.input[key]) !== JSON.stringify(value)) {
                  return false;
                }
              }
              return true;
            });

            if (matches.length === 0) {
              errors.push(
                `No match found for tool="${filter.tool}" with params=${JSON.stringify(filter.params)}`,
              );
              continue;
            }

            if (matches.length > 1) {
              errors.push(
                `Multiple matches (${matches.length}) for tool="${filter.tool}" with params=${JSON.stringify(filter.params)}. Add more params to narrow down.`,
              );
              continue;
            }

            const match = matches[0]!;
            // Mark this callID for pruning
            prunedSet.add(match.callID);
            pruned++;
            charsSaved += match.outputLength;
          }

          // Estimate tokens: ~4 chars per token for typical text
          const estimatedTokensSaved = Math.round(charsSaved / 4);

          // Find 5 biggest tool calls above 100 token threshold for suggestions
          const TOKEN_THRESHOLD = 300;
          const suggestions = toolParts
            .filter(
              (p) =>
                Math.round(p.outputLength / 4) >= TOKEN_THRESHOLD &&
                !prunedSet.has(p.callID),
            )
            .sort((a, b) => b.outputLength - a.outputLength)
            .slice(0, 5)
            .map((p) => ({
              tool: p.tool,
              params: p.input,
              estimatedTokens: Math.round(p.outputLength / 4),
            }));

          return JSON.stringify({
            pruned,
            estimatedTokensSaved,
            errors,
            suggestions,
          });
        },
      }),
    },
  };
};
