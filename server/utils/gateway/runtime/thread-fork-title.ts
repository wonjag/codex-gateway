import type { AppServerThread, HostRecord } from "~~/shared/types";
import { parseThreadReadResult } from "~~/shared/runtime/app-server";
import { currentGatewayUserId } from "../state/memory";
import { threadForkStore } from "../state/thread-forks";
import { threadMetadataStore } from "../state/thread-metadata";
import { threadSnapshotStore } from "../state/thread-snapshots";
import type { ControllerRegistry } from "./controller-registry";
import { runtimeLog } from "./runtime-log";

/** Retry only naming a known child, including after a crash between identity persistence and name/set. */
export class ThreadForkTitleService {
  private readonly recovering = new Map<string, Promise<void>>();

  constructor(private readonly registry: ControllerRegistry) {}

  recover(host: HostRecord, threadId: string, knownThread?: AppServerThread) {
    if (threadForkStore.pendingTitle(host.id, threadId) === null) return Promise.resolve();
    const key = `${currentGatewayUserId()}:${host.id}:${threadId}`;
    const existing = this.recovering.get(key);
    if (existing !== undefined) return existing;
    const recovery = this.performRecovery(host, threadId, knownThread).finally(() => {
      this.recovering.delete(key);
    });
    this.recovering.set(key, recovery);
    return recovery;
  }

  private async performRecovery(host: HostRecord, threadId: string, knownThread?: AppServerThread) {
    // Metadata reads and name/set do not need to resume or subscribe an idle thread. Still use
    // its normal controller queue so a concurrent Gateway manual rename always wins.
    const lease = this.registry.retainSubscription(host, threadId, "scoped", {
      deferUpstreamSubscription: true,
    });
    try {
      const activeController = await lease.ready;
      await activeController.enqueue(async () => {
        if (threadForkStore.pendingTitle(host.id, threadId) === null) return;
        const thread =
          knownThread ??
          (
            await activeController.client.request(
              "thread/read",
              { threadId, includeTurns: false },
              15_000,
              parseThreadReadResult,
            )
          ).thread;
        // Manual rename clears this marker synchronously before joining the same operation
        // queue. Recheck after the metadata await, before issuing any default name write.
        const pending = threadForkStore.pendingTitle(host.id, threadId);
        if (pending === null) return;
        let current = thread;
        if (
          thread.name !== pending.pending_title &&
          (thread.name === pending.expected_name || thread.name === null)
        ) {
          await activeController.client.request(
            "thread/name/set",
            { threadId, name: pending.pending_title },
            15_000,
          );
          current = { ...thread, name: pending.pending_title };
        }
        // A different explicit upstream name is a user choice. Clear pending without replacing
        // it; a previous successful-but-unacknowledged name/set also reaches this idempotent path.
        threadForkStore.clearPendingTitle(host.id, threadId);
        const operation = threadForkStore.get(host.id, pending.operation_id);
        threadMetadataStore.record(host.id, operation?.projectId ?? null, current);
        threadSnapshotStore.update(host.id, threadId, (snapshot) =>
          snapshot === null
            ? null
            : { ...snapshot, thread: { ...snapshot.thread, name: current.name } },
        );
      });
    } catch {
      const pending = threadForkStore.pendingTitle(host.id, threadId);
      if (pending !== null) {
        threadForkStore.finishWithError(
          host.id,
          pending.operation_id,
          "created",
          "The branch exists. Its default title will be retried when it is opened or its status is checked; a manual name will be preserved.",
        );
      }
      runtimeLog("thread fork title recovery deferred", { hostId: host.id, threadId });
    } finally {
      lease.release();
    }
  }
}
