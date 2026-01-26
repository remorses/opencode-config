import type { Plugin } from "@opencode-ai/plugin"

export const BranchInjector: Plugin = async ({ $ }) => {
  // Track last known branch per session
  const sessionBranches = new Map<string, string>()

  return {
    "chat.message": async (input, output) => {
      const result = await $`git branch --show-current`.quiet()
      const branch = result.stdout.toString().trim()

      if (!branch) return // Not in git repo or detached HEAD

      const lastBranch = sessionBranches.get(input.sessionID)

      // Only inject if unknown or changed
      if (lastBranch === branch) return

      // Update tracking
      sessionBranches.set(input.sessionID, branch)

      // Determine message based on whether branch changed or first time
      const info = lastBranch
        ? `[Branch changed: ${lastBranch} → ${branch}]`
        : `[Current branch: ${branch}]`

      // Find last text part and append
      const lastTextPart = [...output.parts]
        .reverse()
        .find((p) => p.type === "text")

      if (lastTextPart && lastTextPart.type === "text") {
        lastTextPart.text += `\n\n${info}`
      }
    },

    // Clean up on session delete
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        sessionBranches.delete(event.properties.info.id)
      }
    },
  }
}
