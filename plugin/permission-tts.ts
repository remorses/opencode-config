import type { Plugin } from "@opencode-ai/plugin";
import type { Permission } from "@opencode-ai/sdk";
import { getProjectFolder, speak, VOICES } from "./utils/tts";

function formatPermissionMessage(permission: Permission, folder: string): string {
  const { type, title } = permission;

  const parts = ["permission required"];

  if (folder) {
    parts.push(`in ${folder}`);
  }

  if (type === "bash") {
    parts.push("for command");
  } else if (type === "edit") {
    parts.push("for edit");
  } else if (type === "webfetch") {
    parts.push("for web fetch");
  } else if (type === "external_directory") {
    parts.push("for external directory");
  }

  if (title) {
    const shortTitle = title.split(/\s+/).slice(0, 5).join(" ");
    if (shortTitle.length <= 50) {
      parts.push(shortTitle);
    }
  }

  return parts.join(" ").trim();
}

export const PermissionTtsPlugin: Plugin = async ({ project, $ }) => {
  const announcedPermissions = new Set<string>();

  async function announcePermission(permission: Permission) {
    if (announcedPermissions.has(permission.id)) {
      return;
    }
    announcedPermissions.add(permission.id);

    // Clean up old permissions (keep last 100)
    if (announcedPermissions.size > 100) {
      const ids = Array.from(announcedPermissions);
      ids.slice(0, ids.length - 100).forEach((id) => announcedPermissions.delete(id));
    }

    const folder = getProjectFolder(project);
    const message = formatPermissionMessage(permission, folder);

    await speak({ message, $, voice: VOICES.permission });
  }

  return {
    async event({ event }) {
      if (event.type === "permission.updated") {
        await announcePermission(event.properties);
      }
    },
  };
};
