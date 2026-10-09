import { z } from "zod";
import type { HostRecord, ThreadForkOperation } from "~~/shared/types";
import { isAppServerSubAgentThread, parseThreadReadResult } from "~~/shared/runtime/app-server";
import { CodexRpcError } from "../http/errors";
import { gatewayThreadFromAppServer } from "../protocol/gateway-thread";
import { currentGatewayUserId } from "../state/memory";
import { threadForkStore, type ThreadForkInput } from "../state/thread-forks";
import { threadMetadataStore } from "../state/thread-metadata";
import { threadSnapshotStore } from "../state/thread-snapshots";
import type { ControllerRegistry, ThreadSubscriptionLease } from "./controller-registry";
import { protectManualTitle } from "./thread-title";
import { runtimeLog } from "./runtime-log";
import { ThreadForkTitleService } from "./thread-fork-title";
import { recordFromUnknown } from "~~/shared/utils/records";

const forkIdentitySchema = z.object({ thread: z.object({ id: z.string().min(1) }) });
const MAX_CONCURRENT_FORKS_PER_HOST = 2;

export class ThreadForkService {
  private readonly pending = new Map<string, Promise<ThreadForkOperation>>();
  private readonly activeByHost = new Map<string, number>();
  private readonly titles: ThreadForkTitleService;

  constructor(private readonly registry: ControllerRegistry) {
    this.titles = new ThreadForkTitleService(registry);
  }

  fork(host: HostRecord, input: ThreadForkInput): Promise<ThreadForkOperation> {
    const hostKey = `${currentGatewayUserId()}:${host.id}`;
    const key = `${hostKey}:${input.operationId}`;
    const existing = threadForkStore.get(host.id, input.operationId);
    if (existing !== null) {
      if (existing.sourceThreadId !== input.threadId || existing.lastTurnId !== input.lastTurnId) {
        throw new Error("Fork operation ID belongs to a different source or turn");
      }
      return (
        this.pending.get(key) ??
        this.status(host, input.operationId).then((operation) => operation ?? existing)
      );
    }
    const active = this.activeByHost.get(hostKey) ?? 0;
    if (active >= MAX_CONCURRENT_FORKS_PER_HOST) {
      throw new Error("Too many fork operations are running on this host. Try again shortly.");
    }
    threadForkStore.create(host.id, input);
    this.activeByHost.set(hostKey, active + 1);
    const pending = this.performFork(host, input).finally(() => {
      this.pending.delete(key);
      const remaining = (this.activeByHost.get(hostKey) ?? 1) - 1;
      if (remaining === 0) this.activeByHost.delete(hostKey);
      else this.activeByHost.set(hostKey, remaining);
    });
    this.pending.set(key, pending);
    return pending;
  }

  async status(host: HostRecord, operationId: string) {
    const operation = threadForkStore.get(host.id, operationId);
    const key = `${currentGatewayUserId()}:${host.id}:${operationId}`;
    // Identity is durable before the remote title is set. A reconnecting browser should wait for
    // this short setup phase instead of caching the inherited source title on its first open.
    if (operation?.status === "created" && this.pending.has(key)) {
      return { ...operation, status: "creating" as const };
    }
    if (operation?.status === "created" && operation.threadId !== null) {
      await this.titles.recover(host, operation.threadId);
      return this.requireOperation(host, operationId);
    }
    return operation;
  }

  async recoverTitle(host: HostRecord, threadId: string) {
    const title = threadForkStore.pendingTitle(host.id, threadId);
    if (title === null) return;
    const key = `${currentGatewayUserId()}:${host.id}:${title.operation_id}`;
    const pending = this.pending.get(key);
    if (pending !== undefined) await pending;
    else await this.titles.recover(host, threadId);
  }

  private async performFork(host: HostRecord, input: ThreadForkInput) {
    const startedAt = Date.now();
    let nativeStartedAt: number | null = null;
    let nativeCompletedAt: number | null = null;
    let dispatched = false;
    let childId: string | null = null;
    let lease: ThreadSubscriptionLease | undefined;
    try {
      const client = await this.registry.getHostClient(host);
      // This bounded metadata read establishes the source workspace. The native fork validates
      // the exact terminal Turn and freezes its prefix; do not walk history in Gateway first.
      const { thread: source } = await client.request(
        "thread/read",
        { threadId: input.threadId, includeTurns: false },
        120_000,
        parseThreadReadResult,
      );
      if (isAppServerSubAgentThread(source)) {
        throw new UnsupportedForkSourceError();
      }
      const title = forkTitle(
        gatewayThreadFromAppServer(host.id, null, source).title,
        source.preview,
      );
      const summary = threadSnapshotStore.get(host.id, source.id)?.threadSettings?.summary;
      const workspaceRoots = source.environments?.[0]?.runtimeWorkspaceRoots;
      dispatched = true;
      nativeStartedAt = Date.now();
      const result = await client.request(
        "thread/fork",
        {
          threadId: input.threadId,
          lastTurnId: input.lastTurnId,
          cwd: source.cwd,
          // Unlike resume, native fork does not merge persisted model/provider settings into
          // its config. Explicit overrides preserve the source's current configured model.
          model: source.model,
          modelProvider: source.modelProvider,
          ...(workspaceRoots === undefined ? {} : { runtimeWorkspaceRoots: workspaceRoots }),
          config: {
            ...(source.reasoningEffort === null
              ? {}
              : { model_reasoning_effort: source.reasoningEffort }),
            ...(summary == null ? {} : { model_reasoning_summary: summary }),
          },
          excludeTurns: true,
          // true copies the source's CURRENT goal, even when branching at an earlier position.
          // No goal or automatic continuation is inherited by a history-only branch.
          deferGoalContinuation: false,
        },
        120_000,
      );
      nativeCompletedAt = Date.now();
      childId = forkIdentitySchema.parse(result).thread.id;
      // Persist the identity before parsing optional metadata, renaming, or handing off the
      // subscription. Retrying any later failure must open this child rather than fork again.
      const inheritedName = recordFromUnknown(recordFromUnknown(result)?.thread)?.name;
      threadForkStore.created(
        host.id,
        input.operationId,
        childId,
        source.cwd,
        title,
        typeof inheritedName === "string" || inheritedName === null ? inheritedName : source.name,
      );
      protectManualTitle(host.id, childId);
      const projectId = this.requireOperation(host, input.operationId).projectId;
      // Fork has a materialized rollout and an implicit subscription. A scoped owner releases it
      // after setup (or transfers to an overlapping browser owner); a fresh-start bootstrap owner
      // would instead leak until the first child turn, which the user may never send.
      lease = this.registry.retainSubscription(host, childId, "scoped", {
        upstreamAlreadySubscribed: true,
      });
      await lease.ready;
      const { thread } = parseThreadReadResult(result);
      threadMetadataStore.record(host.id, projectId, thread);
      await this.titles.recover(host, childId, thread);
    } catch (error) {
      const rpcCode = error instanceof CodexRpcError ? error.rpcCode : null;
      const rejected = isDefinitiveForkRejection(error);
      const status =
        childId !== null ? "created" : dispatched && !rejected ? "outcome-unknown" : "failed";
      // Only fixed messages cross the browser/database boundary: upstream errors may contain
      // prompts, credentials, remote stderr, or private paths. Log correlation IDs and codes.
      const message =
        childId !== null
          ? "The branch was created, but its title or subscription setup could not finish. Open the existing branch; do not create it again."
          : status === "outcome-unknown"
            ? "The fork result is unknown. Check the session list before creating another branch. This operation will not be retried automatically."
            : error instanceof UnsupportedForkSourceError
              ? "Only main conversations can be forked. Open the parent conversation to choose a finished turn."
              : rejected
                ? "This turn cannot be forked. Choose a persisted, finished turn; the source session is unchanged."
                : "The fork could not be prepared. Check the host connection and source session.";
      threadForkStore.finishWithError(host.id, input.operationId, status, message);
      runtimeLog("thread fork failed", {
        hostId: host.id,
        sourceThreadId: input.threadId,
        operationId: input.operationId,
        childId,
        status,
        rpcCode,
      });
    } finally {
      lease?.release();
    }
    const operation = this.requireOperation(host, input.operationId);
    runtimeLog("thread fork settled", {
      hostId: host.id,
      sourceThreadId: input.threadId,
      operationId: input.operationId,
      childId: operation.threadId,
      status: operation.status,
      durationMs: Date.now() - startedAt,
      prepareDurationMs: nativeStartedAt === null ? null : nativeStartedAt - startedAt,
      nativeDurationMs:
        nativeStartedAt === null || nativeCompletedAt === null
          ? null
          : nativeCompletedAt - nativeStartedAt,
      setupDurationMs: nativeCompletedAt === null ? null : Date.now() - nativeCompletedAt,
    });
    return operation;
  }

  private requireOperation(host: HostRecord, operationId: string) {
    const operation = threadForkStore.get(host.id, operationId);
    if (operation === null) throw new Error("Fork operation not found");
    return operation;
  }
}

class UnsupportedForkSourceError extends Error {}

function isDefinitiveForkRejection(error: unknown) {
  if (!(error instanceof CodexRpcError) || error.rpcMethod !== "thread/fork") return false;
  if (error.rpcCode === -32602 || error.rpcCode === -32601) return true;
  if (error.rpcCode !== -32600) return false;
  // Native validation uses InvalidRequest (-32600). Other failures can occur after child
  // creation, so classify only errors proven to precede fork creation in the supported version.
  return (
    error.message.startsWith("lastTurnId '") ||
    (error.message.startsWith("turn ") &&
      (error.message.includes("not found") || error.message.includes("does not have persisted"))) ||
    error.message === "fork boundary exceeds inherited source history" ||
    error.message.startsWith("no rollout found for thread id ")
  );
}

function forkTitle(name: string | null | undefined, preview: string) {
  const base = ((name?.trim() ?? "") || preview.trim() || "Untitled").replace(/\s+/g, " ");
  const suffix = " · 分支";
  return `${Array.from(base)
    .slice(0, 48 - Array.from(suffix).length)
    .join("")}${suffix}`;
}
