// Plugin that prunes tool call outputs from context to save tokens.
// Marks specified tool calls as pruned so their outputs are replaced with placeholders.

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const PRUNED = "[Output removed - call again if needed]";

const PrunePlugin: Plugin = async ({ client }) => {
  const prunedIds = new Map<string, Set<string>>();

  return {
    "experimental.chat.messages.transform": async (
      _input: {},
      output: { messages: Array<{ parts: any[] }> },
    ) => {
      for (const msg of output.messages) {
        const sessionID = msg.parts[0]?.sessionID;
        const pruned = sessionID && prunedIds.get(sessionID);
        if (!pruned?.size) continue;

        for (const part of msg.parts) {
          if (
            part.type === "tool" &&
            pruned.has(part.callID) &&
            part.state?.output
          ) {
            part.state.output = PRUNED;
          }
        }
      }
    },

    tool: {
      prune: tool({
        description:
          "Aggressively prune tool calls from context to keep the context window small. Call this after completing a task to remove ALL tool outputs no longer needed. Prioritize: 1) Large read/glob/grep outputs from processed files, 2) Failed or superseded calls, 3) Dead-end exploration. Be aggressive - if you don't need it, prune it.",
        args: {
          filters: tool.schema.array(
            tool.schema.object({
              tool: tool.schema.string(),
              params: tool.schema
                .record(tool.schema.string(), tool.schema.any())
                .describe("Subset of params to match exactly 1 tool call"),
            }),
          ),
        },

        async execute(args, ctx) {
          const res = await client.session.messages({
            path: { id: ctx.sessionID },
          });
          if (!res.data)
            return JSON.stringify({
              pruned: 0,
              errors: ["Failed to fetch messages"],
            });

          const toolParts = res.data.flatMap((msg) =>
            msg.parts
              .filter(
                (p): p is typeof p & { type: "tool" } => p.type === "tool",
              )
              .map((p) => ({
                callID: p.callID,
                tool: p.tool,
                input: (p.state as any)?.input ?? {},
                outputLen: ((p.state as any)?.output?.length ?? 0) as number,
              })),
          );

          const pruned = prunedIds.get(ctx.sessionID) ?? new Set();
          prunedIds.set(ctx.sessionID, pruned);

          const errors: string[] = [];
          let count = 0,
            saved = 0;

          for (const filter of args.filters) {
            const matches = toolParts.filter(
              (p) =>
                p.tool === filter.tool &&
                Object.entries(filter.params).every(
                  ([k, v]) => JSON.stringify(p.input[k]) === JSON.stringify(v),
                ),
            );

            if (matches.length === 0) {
              errors.push(`No match: ${filter.tool}`);
            } else if (matches.length > 1) {
              errors.push(
                `${matches.length} matches for ${filter.tool} - add more params`,
              );
            } else {
              pruned.add(matches[0]!.callID);
              count++;
              saved += matches[0]!.outputLen;
            }
          }

          const suggestions = toolParts
            .filter((p) => p.outputLen >= 1200 && !pruned.has(p.callID))
            .sort((a, b) => b.outputLen - a.outputLen)
            .slice(0, 5)
            .map((p) => ({
              tool: p.tool,
              params: p.input,
              tokens: Math.round(p.outputLen / 4),
            }));

          return JSON.stringify({
            pruned: count,
            tokensSaved: Math.round(saved / 4),
            errors,
            suggestions,
          });
        },
      }),
    },
  };
};
