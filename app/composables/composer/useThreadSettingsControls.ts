import { computed, ref, watch } from "vue";

import { storeToRefs } from "pinia";
import {
  agentProviderOptions,
  type AgentProviderId,
  type ApprovalPolicy,
  type ReasoningEffort,
} from "~~/shared/types";
import { firstNonEmptyString, trimmedOrFallback, trimmedOrNull } from "~~/shared/utils/strings";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { useGatewayComposerStore } from "@/stores/gateway-composer";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayProjectDefaultsStore } from "@/stores/gateway-project-defaults";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { modelSelection, type ModelSelection } from "@/utils/model-selection";

export function useThreadSettingsControls() {
  const gateway = useGatewayCatalogStore();
  const composer = useGatewayComposerStore();
  const navigation = useGatewayNavigationStore();
  const projectDefaultsStore = useGatewayProjectDefaultsStore();
  const threadView = useGatewayThreadViewStore();
  const { models, defaultModel, defaultModelProvider } = storeToRefs(gateway);
  const { selectedThreadSettings } = storeToRefs(composer);
  const { selectedHostId, selectedProjectId, selectedThreadId } = storeToRefs(navigation);
  const newThreadModel = ref("");
  const newThreadModelProvider = ref<string | null>(null);
  const newThreadEffort = ref<ReasoningEffort>("default");
  const newThreadApprovalMode = ref<ApprovalPolicy | "custom">("custom");
  const selectedProvider = ref<AgentProviderId>("codex");

  const projectDefaults = computed(() => {
    if (selectedHostId.value === null || selectedProjectId.value === null) return null;
    return projectDefaultsStore.defaultsFor(
      selectedHostId.value,
      selectedProjectId.value,
      selectedProvider.value,
    );
  });
  const newThreadProjectDefaults = computed(() =>
    selectedThreadId.value === null ? projectDefaults.value : null,
  );
  const currentThread = computed(() => {
    const thread = threadView.currentThread;
    return thread?.id === selectedThreadId.value && thread?.hostId === selectedHostId.value
      ? thread
      : null;
  });
  const existingModelProvider = computed(() =>
    firstNonEmptyString([
      currentThread.value?.modelProvider,
      selectedThreadSettings.value.modelProvider,
    ]),
  );
  // The explicit new-thread override remains separate from the effective default used for display.
  // Existing threads retain their native provider even when a model override is cleared.
  const selectedModelProvider = computed(() =>
    selectedThreadId.value === null ? newThreadModelProvider.value : existingModelProvider.value,
  );
  const activeModelProvider = computed(() =>
    selectedThreadId.value === null
      ? firstNonEmptyString([
          newThreadModelProvider.value,
          newThreadProjectDefaults.value?.modelProvider,
          defaultModelProvider.value,
          defaultModel.value?.modelProvider,
        ])
      : existingModelProvider.value,
  );
  const providerModels = computed(() =>
    models.value.filter((model) => {
      const provider = modelSelection(model).modelProvider;
      return provider === null || provider === activeModelProvider.value;
    }),
  );
  const activeModelProviderLabel = computed(() => {
    const record = models.value.find(
      (model) => modelSelection(model).modelProvider === activeModelProvider.value,
    );
    return firstNonEmptyString([record?.providerDisplayName, activeModelProvider.value]) ?? "";
  });

  watch([selectedHostId, selectedProjectId, () => threadView.newThreadDraftToken], () => {
    newThreadModel.value = "";
    newThreadModelProvider.value = null;
    newThreadEffort.value = "default";
    newThreadApprovalMode.value = "custom";
  });

  watch(
    [selectedHostId, selectedProjectId, selectedProvider],
    ([hostId, projectId, provider]) => {
      if (hostId === null || projectId === null) return;
      void projectDefaultsStore.ensure(hostId, projectId, provider).catch((error: unknown) => {
        console.warn("[gateway] failed to resolve remote project defaults", error);
      });
    },
    { immediate: true },
  );

  // Existing-thread controls are computed proxies over the per-thread Pinia state. Do not mirror
  // them into local refs with bidirectional watchers: thread selection, snapshot hydration, and the
  // model catalog arrive independently, and a transient model default can otherwise be written
  // back as the thread's setting. Local refs are retained only for the pre-thread composer, where
  // no app-server thread identity exists yet.
  const selectedModel = computed(() =>
    // An empty new-thread model is the remote-default state: thread.start omits model and effort.
    // The concrete label comes from config/read, but displaying that value must never turn it into
    // a Gateway override because Codex may resolve a changed config by the time creation runs.
    selectedThreadId.value === null
      ? newThreadModel.value
      : (trimmedOrNull(selectedThreadSettings.value.model) ?? ""),
  );
  const selectedEffort = computed<ReasoningEffort>({
    get: () =>
      selectedThreadId.value === null
        ? newThreadEffort.value
        : (selectedThreadSettings.value.effort ?? "default"),
    set: (effort) => {
      if (selectedThreadId.value === null) {
        newThreadEffort.value = effort;
        return;
      }
      void composer.saveSelectedThreadSettings({ effort: effort === "default" ? null : effort });
    },
  });
  const selectedApprovalMode = computed<ApprovalPolicy | "custom">({
    get: () =>
      selectedThreadId.value === null
        ? newThreadApprovalMode.value
        : (selectedThreadSettings.value.approvalPolicy ?? "custom"),
    set: (approvalPolicy) => {
      if (selectedThreadId.value === null) {
        newThreadApprovalMode.value = approvalPolicy;
        return;
      }
      void composer.saveSelectedThreadSettings({
        approvalPolicy: approvalPolicy === "custom" ? null : approvalPolicy,
      });
    },
  });

  const activeModel = computed(() => selectedModel.value);
  // Plan is an explicit app-server setting update, so it needs a concrete model even during the
  // short interval before an existing thread's settings notification arrives. Use the native
  // thread model in that interval: the first catalog entry need not be this thread's model.
  const collaborationModel = computed(
    () =>
      firstNonEmptyString([
        selectedThreadSettings.value.collaborationMode?.settings.model,
        selectedModel.value,
        newThreadProjectDefaults.value?.model,
        currentThread.value?.model,
      ]) ?? "",
  );
  const activeModelRecord = computed(() => {
    const match = providerModels.value.find(
      (candidate) => candidate.model === activeModel.value || candidate.id === activeModel.value,
    );
    // config/read supplies the actual model selected by the remote config layers. models/list is
    // used only to enrich that concrete id with display metadata and supported effort choices.
    if (match !== undefined) return match;
    if (activeModel.value !== "") return null;
    const remoteModel =
      selectedThreadId.value === null
        ? newThreadProjectDefaults.value?.model
        : currentThread.value?.model;
    return (
      providerModels.value.find(
        (candidate) => candidate.model === remoteModel || candidate.id === remoteModel,
      ) ?? null
    );
  });
  const activeModelLabel = computed(() => {
    // The remote-default state has no local override label. The picker renders the concrete
    // config/read value separately, so it remains visually distinct from an explicit selection.
    if (activeModel.value === "") return "";
    const model = activeModelRecord.value;
    return firstNonEmptyString([model?.displayName, model?.model, activeModel.value]) ?? "";
  });
  const hostDefaultModelLabel = computed(() => {
    const remoteModel =
      selectedThreadId.value === null
        ? newThreadProjectDefaults.value?.model
        : currentThread.value?.model;
    const remoteProvider =
      newThreadProjectDefaults.value?.modelProvider ?? defaultModelProvider.value;
    const model =
      selectedThreadId.value === null
        ? models.value.find(
            (candidate) =>
              (candidate.model === remoteModel || candidate.id === remoteModel) &&
              (candidate.modelProvider == null || candidate.modelProvider === remoteProvider),
          )
        : providerModels.value.find(
            (candidate) => candidate.model === remoteModel || candidate.id === remoteModel,
          );
    return firstNonEmptyString([model?.displayName, model?.model, remoteModel]) ?? "";
  });
  // activeEffortValue is the picker's selection state: empty means "follow the host default" and
  // no override is sent. The effective effort (model-level default) is display-only and resolved
  // separately for the compact trigger label.
  const activeEffortValue = computed(() =>
    selectedEffort.value === "default" ? "" : selectedEffort.value,
  );
  const hostDefaultEffortLabel = computed(() =>
    compactEffortLabel(
      (activeModel.value === "" ? newThreadProjectDefaults.value?.effort : null) ??
        activeModelRecord.value?.defaultReasoningEffort ??
        "",
    ),
  );
  const activeEffortCompactLabel = computed(() => {
    if (selectedEffort.value === "default") return hostDefaultEffortLabel.value;
    return compactEffortLabel(selectedEffort.value);
  });
  const effortOptions = computed(() => {
    const supportedEfforts = activeModelRecord.value?.supportedReasoningEfforts ?? [];
    const options = supportedEfforts.map((option) => ({
      value: option.reasoningEffort,
      label: option.reasoningEffort,
    }));
    if (
      selectedEffort.value !== "default" &&
      !options.some((option) => option.value === selectedEffort.value)
    ) {
      options.unshift({ value: selectedEffort.value, label: selectedEffort.value });
    }
    return options;
  });

  function compactEffortLabel(value: string) {
    if (value === "") return "";
    const normalized = value.toLowerCase().replaceAll("_", "-");
    const knownLabels: Record<string, string> = {
      low: "Light",
      light: "Light",
      medium: "Medium",
      high: "High",
      "extra-high": "Extra High",
      xhigh: "Extra High",
    };
    const knownLabel = knownLabels[normalized];
    if (knownLabel !== undefined) return knownLabel;
    return value
      .split(/[-_\s]+/)
      .filter((part) => part !== "")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function labelEffortOption(option: { value: ReasoningEffort; label?: string }) {
    return compactEffortLabel(trimmedOrFallback(option.label, option.value));
  }

  function setSelectedModel(selection: ModelSelection) {
    const model = trimmedOrNull(selection.model);
    const modelProvider = model === null ? null : trimmedOrNull(selection.modelProvider);
    if (selectedThreadId.value === null) {
      newThreadModel.value = model ?? "";
      newThreadModelProvider.value = modelProvider;
      return;
    }
    // Native model:null preserves an existing model. Do not invent a local "default" state that
    // erases its actual model or makes a later Plan action pick another catalog entry.
    if (model === null) return;
    // A source is fixed by the native thread. Browsing another group must never alter that source.
    if (modelProvider !== null && modelProvider !== existingModelProvider.value) return;
    void composer.saveSelectedThreadSettings({ model, modelProvider });
  }

  function setSelectedEffort(effort: ReasoningEffort) {
    selectedEffort.value = effort;
  }

  function setSelectedApprovalMode(value: ApprovalPolicy | "custom") {
    selectedApprovalMode.value = value;
  }

  // Provider is selected before a thread/turn is sent and is deliberately not stored as a model
  // setting. The current registry has one provider, but keeping this session-level control separate
  // means adding another adapter will not require changing model or reasoning-effort semantics.
  function setSelectedProvider(value: AgentProviderId) {
    selectedProvider.value = value;
  }

  return {
    selectedModel,
    selectedModelProvider,
    selectedEffort,
    selectedApprovalMode,
    activeModel,
    activeModelProvider,
    activeModelProviderLabel,
    collaborationModel,
    activeModelLabel,
    hostDefaultModelLabel,
    hostDefaultEffortLabel,
    activeEffortValue,
    activeEffortCompactLabel,
    effortOptions,
    labelEffortOption,
    setSelectedModel,
    setSelectedEffort,
    setSelectedApprovalMode,
    selectedProvider,
    providerOptions: agentProviderOptions,
    setSelectedProvider,
  };
}
