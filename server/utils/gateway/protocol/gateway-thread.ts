import type { AppServerThread, GatewayThread } from "~~/shared/types";
import { currentGatewayMemoryState } from "../state/memory";
import { threadForkStore } from "../state/thread-forks";

/**
 * The browser boundary is the only place that enriches an official app-server Thread. Runtime
 * snapshots must retain the exact upstream DTO so user-scoped Gateway pins can never leak back
 * into RPC state or be mistaken for Codex's app-server-global section membership.
 */
export function gatewayThreadFromAppServer(
  hostId: number,
  projectId: number | null,
  thread: AppServerThread,
): GatewayThread {
  const pinned = currentGatewayMemoryState().pinnedThreads.find(
    (candidate) => candidate.hostId === hostId && candidate.threadId === thread.id,
  );
  // App-server 0.149 introduced its own global project catalog with opaque string IDs. Gateway
  // projects remain user-scoped SQLite rows with numeric IDs, so rename the upstream field at
  // this sole projection boundary instead of letting two unrelated identities share `projectId`.
  const { projectId: appServerProjectId, ...appServerThread } = thread;
  return {
    ...appServerThread,
    appServerProjectId,
    hostId,
    projectId,
    pinned: pinned !== undefined,
    title: pinned?.title ?? thread.name,
    forkOrigin: threadForkStore.origin(hostId, thread.id),
  };
}
