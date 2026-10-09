import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { toast } from "@codex-gateway/ui/sonner";
import {
  threadForkReferenceSchema,
  type ThreadForkOperation,
  type ThreadForkReference,
} from "~~/shared/types/thread-fork";
import { useGatewayTranslator } from "@/composables/i18n/useGatewayTranslator";
import { createUuid } from "@/lib/uuid";
import { useAuthStore } from "@/stores/auth";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { RealtimeRequestError } from "@/stores/gateway-realtime/request-errors";
import { captureSessionEpoch } from "@/utils/session-epoch";
import { requestThreadFork, requestThreadForkStatus } from "./transport";

function scopeKey(hostId: number, threadId: string, turnId: string) {
  return JSON.stringify([hostId, threadId, turnId]);
}

export const useGatewayThreadForkStore = defineStore("gateway-thread-fork", () => {
  const t = useGatewayTranslator();
  const auth = useAuthStore();
  // Only operation references survive refresh. Outcomes and conversation contents remain server
  // owned; a restored reference must be queried before another creation can be considered.
  const referenceRevision = ref(0);
  const operations = ref<Record<string, ThreadForkOperation>>({});
  const pending = ref<Record<string, boolean>>({});
  const focusRequest = ref<{ hostId: number; threadId: string; token: string } | null>(null);

  watch(
    () => auth.sessionEpoch,
    () => {
      operations.value = {};
      pending.value = {};
      focusRequest.value = null;
    },
    { flush: "sync" },
  );

  function referenceKey(key: string) {
    return `codex-gateway:${encodeURIComponent(auth.username)}:fork-operation:${encodeURIComponent(key)}`;
  }

  useEventListener("storage", (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(referenceKey(""))) referenceRevision.value += 1;
  });

  function operationFor(hostId: number, threadId: string, turnId: string) {
    const key = scopeKey(hostId, threadId, turnId);
    const operation = operations.value[key];
    // Each source boundary has its own storage entry: concurrent tabs for different turns cannot
    // overwrite a shared map and lose an unknown creation's recovery id.
    void referenceRevision.value;
    if (!import.meta.client) return operation ?? null;
    let value: unknown;
    try {
      value = JSON.parse(localStorage.getItem(referenceKey(key)) ?? "null");
    } catch {
      return operation ?? null;
    }
    const saved = threadForkReferenceSchema.safeParse(value);
    if (!saved.success) return operation ?? null;
    if (
      saved.data.hostId !== hostId ||
      saved.data.sourceThreadId !== threadId ||
      saved.data.lastTurnId !== turnId
    )
      return operation ?? null;
    // A different tab may have retried a failed operation. Its new unresolved identity takes
    // precedence over our stale failure, so Retry cannot accidentally create a third branch.
    if (operation?.operationId === saved.data.operationId) return operation;
    return unresolvedOperation(saved.data);
  }

  function isPending(hostId: number, threadId: string, turnId: string) {
    return pending.value[scopeKey(hostId, threadId, turnId)] === true;
  }

  async function openBranch(operation: ThreadForkOperation) {
    if (operation.threadId === null) return;
    const sessionIsCurrent = captureSessionEpoch();
    const views = useGatewayThreadViewStore();
    await views.openThread(operation.threadId, {
      hostId: operation.hostId,
      projectId: operation.projectId,
    });
    if (!sessionIsCurrent()) return;
    const navigation = useGatewayNavigationStore();
    if (
      navigation.selectedHostId !== operation.hostId ||
      navigation.selectedThreadId !== operation.threadId
    )
      return;
    if (views.currentThread?.id !== operation.threadId || views.history === null) {
      toast.error(t("app.forkOpenFailed"), {
        action: {
          label: t("app.forkOpenBranch"),
          onClick: () => {
            if (sessionIsCurrent()) void openBranch(operation);
          },
        },
      });
      return;
    }
    // Update just this row after the authoritative activation. A host-wide list refresh toggles
    // the current chat's loading state and can overwrite a newer project selection.
    navigation.threads = [
      views.currentThread,
      ...navigation.threads.filter((thread) => thread.id !== operation.threadId),
    ];
    focusRequest.value = {
      hostId: operation.hostId,
      threadId: operation.threadId,
      token: createUuid(),
    };
  }

  async function runOperation(reference: ThreadForkReference, create: boolean) {
    const key = scopeKey(reference.hostId, reference.sourceThreadId, reference.lastTurnId);
    if (pending.value[key] === true) return;
    const sessionIsCurrent = captureSessionEpoch();
    const views = useGatewayThreadViewStore();
    const navigation = useGatewayNavigationStore();
    const viewEpoch = views.viewEpoch;
    const selectedProjectId = navigation.selectedProjectId;
    pending.value[key] = true;
    if (create) operations.value[key] = { ...unresolvedOperation(reference), status: "creating" };
    try {
      const operation = await (create
        ? requestThreadFork(reference)
        : requestThreadForkStatus(reference));
      if (!sessionIsCurrent()) return;
      if (
        operation.operationId !== reference.operationId ||
        operation.hostId !== reference.hostId ||
        operation.sourceThreadId !== reference.sourceThreadId ||
        operation.lastTurnId !== reference.lastTurnId
      )
        throw new Error("Fork response scope mismatch");
      operations.value[key] = operation;
      if (operation.status === "created") {
        if (operation.error !== null)
          toast.warning(t("app.forkPreparationWarning"), { description: operation.error });
        if (
          views.viewEpoch === viewEpoch &&
          navigation.selectedHostId === reference.hostId &&
          navigation.selectedThreadId === reference.sourceThreadId &&
          navigation.selectedProjectId === selectedProjectId
        ) {
          await openBranch(operation);
        } else {
          toast.success(t("app.forkCreated"), {
            action: {
              label: t("app.forkOpenBranch"),
              onClick: () => {
                if (sessionIsCurrent()) void openBranch(operation);
              },
            },
          });
        }
      } else if (operation.status === "failed") {
        toast.error(t("app.forkFailed"), { description: operation.error ?? undefined });
      } else {
        toast.info(
          t(operation.status === "creating" ? "app.forkStillCreating" : "app.forkOutcomeUnknown"),
        );
      }
    } catch (error) {
      if (!sessionIsCurrent()) return;
      const existing = operations.value[key];
      if (existing?.operationId === reference.operationId && existing.status === "created") {
        toast.error(t("app.forkOpenFailed"));
        return;
      }
      if (
        error instanceof RealtimeRequestError &&
        error.details.code === "FORK_OPERATION_NOT_FOUND"
      ) {
        operations.value[key] = { ...unresolvedOperation(reference), status: "failed" };
        toast.error(t("app.forkFailed"));
        return;
      }
      // A missing response does not prove the native creation failed. Preserve the operation id
      // and query it on the next click instead of silently issuing another thread/fork.
      operations.value[key] = unresolvedOperation(reference);
      toast.error(t("app.forkOutcomeUnknown"));
    } finally {
      if (sessionIsCurrent()) delete pending.value[key];
    }
  }

  async function forkThread(
    hostId: number,
    threadId: string,
    lastTurnId: string,
    options: { newBranch?: boolean } = {},
  ) {
    const key = scopeKey(hostId, threadId, lastTurnId);
    if (pending.value[key] === true) return;
    const existing = operationFor(hostId, threadId, lastTurnId);
    if (
      existing !== null &&
      existing.status !== "failed" &&
      !(options.newBranch === true && existing.status === "created")
    ) {
      await resumeOperation(hostId, threadId, lastTurnId);
      return;
    }
    const reference = { operationId: createUuid(), hostId, sourceThreadId: threadId, lastTurnId };
    try {
      localStorage.setItem(referenceKey(key), JSON.stringify(reference));
      referenceRevision.value += 1;
    } catch {
      toast.error(t("app.forkRecoveryStorageFailed"));
      return;
    }
    await runOperation(reference, true);
  }

  async function resumeOperation(hostId: number, threadId: string, lastTurnId: string) {
    const operation = operationFor(hostId, threadId, lastTurnId);
    if (operation === null || isPending(hostId, threadId, lastTurnId)) return;
    await runOperation(operation, false);
  }

  function clearFocusRequest(token: string) {
    if (focusRequest.value?.token === token) focusRequest.value = null;
  }

  return {
    focusRequest,
    operationFor,
    isPending,
    forkThread,
    resumeOperation,
    clearFocusRequest,
  };
});

function unresolvedOperation(reference: ThreadForkReference): ThreadForkOperation {
  return {
    ...reference,
    status: "outcome-unknown",
    threadId: null,
    projectId: null,
    error: null,
  };
}
