import { useGatewayThreadRuntimeStore } from "@/stores/gateway-thread-runtime";
import { useGatewayTurnQueueStore } from "@/stores/gateway-turn-queue";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { computed, type Ref } from "vue";

import type { ComposerTurnOptions } from "~~/shared/types";
import type { ComposerFileReference } from "@/stores/gateway/types";
import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayComposerStore } from "@/stores/gateway-composer";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { useGatewayThreadTurnsStore } from "@/stores/gateway-thread-turns";
import { buildThreadCollaborationMode } from "@/utils/thread-collaboration-mode";
import { messageFromError } from "@/stores/gateway/thread-utils/identity";

type AttachedFile = {
  name: string;
  path: string;
  mimeType?: string | null;
  size: number;
  isImage: boolean;
  dataUrl?: string;
};

export function useComposerTurnSubmit(input: {
  turnText: Ref<string>;
  attachedFiles: Ref<AttachedFile[]>;
  fileReferences: Ref<ComposerFileReference[]>;
  clearDraft: () => void;
  selectedTurnOptions: () => ComposerTurnOptions;
  collaborationModel: Ref<string>;
  selectedEffort: Ref<string>;
  fileReferencesLabel: Ref<string>;
}) {
  const gateway = useGatewayBootstrapStore();
  const composer = useGatewayComposerStore();
  const threadView = useGatewayThreadViewStore();
  const threadTurns = useGatewayThreadTurnsStore();
  const interruptingTurn = ref(false);
  const planModeActive = computed(() => composer.selectedThreadCollaborationMode === "plan");
  const hasComposerInput = computed(() =>
    Boolean(input.turnText.value.trim() || input.attachedFiles.value.length),
  );

  async function activatePlanMode() {
    if (await saveCollaborationMode("plan")) input.turnText.value = "";
  }

  async function deactivatePlanMode() {
    await saveCollaborationMode("default");
  }

  async function startNewThread() {
    input.clearDraft();
    threadView.prepareNewThread();
  }

  const submitting = ref(false);
  const creatingThread = ref(false);
  async function submitTurn(insert = false) {
    if (submitting.value) return;
    const draftText = input.turnText.value;
    const text = draftText.trim();
    if (!text && !input.attachedFiles.value.length) return;
    if (planModeActive.value) {
      composer.dismissLatestSelectedPlanPrompt();
    }
    const files = [...input.attachedFiles.value];
    const remoteFiles = files.filter((file) => !file.isImage);
    const attachedImages = files.filter((file) => file.isImage);
    const draftReferences = [...input.fileReferences.value];
    const references = draftReferences.map(({ type, path, name }) => ({
      type,
      path,
      name,
    }));
    const collaborationMode = composer.selectedThreadSettings.collaborationMode ?? undefined;
    const options = input.selectedTurnOptions();
    const navigation = useGatewayNavigationStore();
    const { selectedHostId: hostId, selectedProjectId: projectId } = navigation;
    let threadId = navigation.selectedThreadId;
    if (hostId === null || projectId === null || (insert && threadId === null)) return;
    submitting.value = true;
    try {
      if (threadId === null) {
        creatingThread.value = true;
        threadId = await threadView.startThread(options);
        // Navigating or logging out while creation is in flight must never send the first
        // message to the newly selected session. startThread also fences stale view responses.
        if (
          threadId === null ||
          navigation.selectedHostId !== hostId ||
          navigation.selectedProjectId !== projectId ||
          navigation.selectedThreadId !== threadId
        ) {
          return;
        }
        // Selection hydrates the per-thread composer. Transfer the submitted draft to that real
        // thread so a rejected first turn keeps its text, attachments, and references for retry.
        input.turnText.value = draftText;
        input.attachedFiles.value = files;
        input.fileReferences.value = draftReferences;
      }
      const targetThreadId = threadId;
      const queue = useGatewayTurnQueueStore();
      const runtime = useGatewayThreadRuntimeStore();
      const running = runtime.statusFor(hostId, targetThreadId) === "running";
      const expectedTurnId = runtime.activeTurnIdsByThreadKey[`${hostId}:${targetThreadId}`];
      const shouldQueue =
        insert || running || (queue.queues[`${hostId}:${targetThreadId}`]?.length ?? 0) > 0;
      const send = !shouldQueue
        ? threadTurns.sendTurn
        : (text: string, turnOptions: ComposerTurnOptions) =>
            queue.enqueue(
              hostId,
              targetThreadId,
              projectId,
              text,
              turnOptions,
              insert ? expectedTurnId : null,
            );
      const accepted = await send(
        messageWithFileReferences(text, remoteFiles, input.fileReferencesLabel.value),
        {
          ...options,
          collaborationMode,
          images: attachedImages
            .map((file) => ({ url: file.dataUrl, detail: "auto" as const }))
            .filter((image): image is { url: string; detail: "auto" } => Boolean(image.url)),
          files: remoteFiles,
          references,
        },
      );
      if (
        accepted !== false &&
        navigation.selectedHostId === hostId &&
        navigation.selectedThreadId === threadId &&
        input.turnText.value.trim() === text
      )
        input.clearDraft();
    } catch (error: unknown) {
      gateway.setError(
        messageFromError(error, gateway.t("app.sendMessageFailed"), gateway.errorLabels),
        { hostId, projectId, threadId },
      );
    } finally {
      creatingThread.value = false;
      submitting.value = false;
    }
  }

  async function interruptTurn() {
    if (interruptingTurn.value) {
      return;
    }
    interruptingTurn.value = true;
    try {
      await threadTurns.interruptActiveTurn();
    } finally {
      interruptingTurn.value = false;
    }
  }

  async function saveCollaborationMode(mode: "default" | "plan") {
    const collaborationMode = buildThreadCollaborationMode({
      mode,
      modelCandidates: [input.collaborationModel.value],
      effort: input.selectedEffort.value === "default" ? null : input.selectedEffort.value,
    });
    if (collaborationMode === null) {
      gateway.setError(gateway.t("app.planModeModelUnavailable"));
      return false;
    }
    // The strip reflects the app-server's accepted next-turn settings. A local-only mode flag can
    // diverge from Codex during thread hydration, which was the regression fixed here.
    return composer.saveSelectedThreadSettings({ collaborationMode });
  }

  return {
    planModeActive,
    hasComposerInput,
    interruptingTurn,
    submitting,
    creatingThread,
    activatePlanMode,
    deactivatePlanMode,
    startNewThread,
    submitTurn,
    interruptTurn,
  };
}

function messageWithFileReferences(text: string, remoteFiles: AttachedFile[], label: string) {
  const fileReferences = remoteFiles.map((file) => `- ${file.name}: ${file.path}`);
  return fileReferences.length
    ? `${text}${text ? "\n\n" : ""}${label}\n${fileReferences.join("\n")}`
    : text;
}
