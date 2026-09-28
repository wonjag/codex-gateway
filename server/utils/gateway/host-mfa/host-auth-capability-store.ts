import { createHash } from "node:crypto";
import type { HostRecord } from "~~/shared/types";
import { gatewayDatabase } from "../storage/database";
import { hostRuntimeFingerprint } from "../runtime/host-runtime-fingerprint";

function capabilityFingerprint(host: HostRecord) {
  // Persist only a digest: the runtime fingerprint includes credentials and proxy authentication.
  return createHash("sha256").update(hostRuntimeFingerprint(host)).digest("hex");
}

export const hostAuthCapabilityStore = {
  requiresKeyboardInteractive(userId: number, host: HostRecord) {
    const row = gatewayDatabase()
      .prepare(
        `
          SELECT host_fingerprint, requires_keyboard_interactive
          FROM host_auth_capabilities
          WHERE user_id = ? AND host_id = ?
        `,
      )
      .get(userId, host.id);
    return (
      row !== undefined &&
      String(row.host_fingerprint) === capabilityFingerprint(host) &&
      Number(row.requires_keyboard_interactive) === 1
    );
  },

  markKeyboardInteractive(userId: number, host: HostRecord) {
    gatewayDatabase()
      .prepare(
        `
          INSERT INTO host_auth_capabilities (
            user_id,
            host_id,
            host_fingerprint,
            requires_keyboard_interactive,
            updated_at
          ) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(user_id, host_id) DO UPDATE SET
            host_fingerprint = excluded.host_fingerprint,
            requires_keyboard_interactive = 1,
            updated_at = excluded.updated_at
        `,
      )
      .run(userId, host.id, capabilityFingerprint(host), new Date().toISOString());
  },

  pruneHosts(userId: number, activeHostIds: ReadonlySet<number>) {
    const rows = gatewayDatabase()
      .prepare("SELECT host_id FROM host_auth_capabilities WHERE user_id = ?")
      .all(userId);
    const remove = gatewayDatabase().prepare(
      "DELETE FROM host_auth_capabilities WHERE user_id = ? AND host_id = ?",
    );
    for (const row of rows) {
      const hostId = Number(row.host_id);
      if (!activeHostIds.has(hostId)) remove.run(userId, hostId);
    }
  },
};
