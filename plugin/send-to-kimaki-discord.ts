/**
 * Kimaki Discord Plugin for OpenCode
 *
 * Adds /send-to-kimaki-discord command that sends the current session to Discord.
 *
 * Installation:
 *   kimaki install-plugin
 *
 * Then add the command to your ~/.config/opencode/opencode.jsonc:
 *   {
 *     "command": {
 *       "send-to-kimaki-discord": {
 *         "description": "Send current session to Kimaki Discord",
 *         "template": "Session is being sent to Discord..."
 *       }
 *     }
 *   }
 *
 * Use in OpenCode TUI:
 *   /send-to-kimaki-discord
 */

import type { Plugin } from '@opencode-ai/plugin'

export const KimakiDiscordPlugin: Plugin = async ({
  $,
  directory,
}) => {
  return {
    event: async ({ event }) => {
      if (event.type !== 'command.executed') {
        return
      }

      const { name, sessionID } = event.properties as {
        name: string
        sessionID: string
      }

      if (name !== 'send-to-kimaki-discord') {
        return
      }

      if (!sessionID) {
        console.error('[Kimaki] No session ID available')
        return
      }

      console.log(`[Kimaki] Sending session ${sessionID} to Discord...`)

      try {
        const result =
          await $`npx -y kimaki send-to-discord ${sessionID} -d ${directory}`.text()
        console.log(`[Kimaki] ${result}`)
      } catch (error: any) {
        console.error(
          `[Kimaki] Failed to send to Discord:`,
          error.message || error,
        )
      }
    },
  }
}
