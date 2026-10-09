import { projectStore } from "../state/projects";

export class ThreadWorkspaceMismatchError extends Error {
  constructor() {
    super("Queued thread workspace changed");
    this.name = "ThreadWorkspaceMismatchError";
  }
}

export function resolveThreadProjectId(
  hostId: number,
  projectId: number | null,
  cwd: string | null | undefined,
) {
  const requested = projectId === null ? null : projectStore.get(projectId);
  if (typeof cwd !== "string" || cwd.trim() === "") {
    return requested?.hostId === hostId ? requested.id : null;
  }
  if (requested?.hostId === hostId && requested.remotePath === cwd) return requested.id;
  // The native thread owns its directory. A stale route or cached selection must never move it
  // into another workspace, including when both projects belong to the same host.
  return projectStore.ensureForPath(hostId, cwd).id;
}
