<script setup lang="ts">
import { CheckIcon, ChevronDownIcon } from "@lucide/vue";
import { computed, ref } from "vue";
import type {
  AgentProviderId,
  AgentProviderOption,
  ModelRecord,
  ReasoningEffort,
} from "~~/shared/types";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from "@codex-gateway/ai-elements/model-selector";
import { Button } from "@codex-gateway/ui/button";
import ModelProviderGroup from "@/components/chat/composer/ModelProviderGroup.vue";
import { useAccountLocalStorage } from "@/composables/storage/useAccountLocalStorage";
import { modelSelection, type ModelSelection } from "@/utils/model-selection";

const props = defineProps<{
  models: ModelRecord[];
  loadingModels: boolean;
  activeModel: string;
  activeModelLabel: string;
  activeModelProvider: string | null;
  activeModelProviderLabel: string;
  hostDefaultModelLabel: string;
  hostDefaultEffortLabel: string;
  activeEffortValue: string;
  activeEffortCompactLabel: string;
  effortOptions: Array<{ value: ReasoningEffort; label?: string }>;
  labelEffortOption: (option: { value: ReasoningEffort; label?: string }) => string;
  selectedProvider: AgentProviderId;
  providerOptions: readonly AgentProviderOption[];
  canSelectProvider: boolean;
}>();

const emit = defineEmits<{
  selectModel: [selection: ModelSelection];
  selectEffort: [effort: ReasoningEffort];
  selectProvider: [provider: AgentProviderId];
}>();

const { t } = useI18n();
const selectorOpen = ref(false);
const expandedProviders = useAccountLocalStorage<Record<string, boolean>>(
  "model-provider-groups",
  {},
);
const modelGroups = computed(() => {
  const groups = new Map<
    string | null,
    { provider: string | null; label: string; models: ModelRecord[] }
  >();
  for (const model of props.models) {
    const provider = modelSelection(model).modelProvider;
    let group = groups.get(provider);
    if (group === undefined) {
      group = {
        provider,
        label: model.providerDisplayName?.trim() || provider || t("app.modelProviderDefault"),
        models: [],
      };
      groups.set(provider, group);
    }
    group.models.push(model);
  }
  return [...groups.values()];
});

function providerIsExpanded(provider: string | null) {
  return (
    expandedProviders.value[JSON.stringify(provider)] ??
    (provider === null || provider === props.activeModelProvider || modelGroups.value.length === 1)
  );
}

function toggleProvider(provider: string | null) {
  expandedProviders.value = {
    ...expandedProviders.value,
    [JSON.stringify(provider)]: !providerIsExpanded(provider),
  };
}

function providerIsLocked(provider: string | null) {
  return !props.canSelectProvider && provider !== null && provider !== props.activeModelProvider;
}

function triggerModelLabel(activeModelLabel: string, hostDefaultModelLabel: string) {
  // The trigger shows the concrete remote value when known. It deliberately does not assign that
  // value to activeModel: an empty activeModel is what keeps thread.start free of an override.
  return activeModelLabel || hostDefaultModelLabel || t("app.modelCodexDefault");
}

function providerLabel(option: AgentProviderOption) {
  return t(option.labelKey);
}

function selectModel(selection: ModelSelection) {
  emit("selectModel", selection);
}

function selectEffort(effort: ReasoningEffort) {
  emit("selectEffort", effort);
}

function preventInitialFocus(event: Event) {
  // Reka Dialog otherwise focuses the first tabbable element while CommandInput also requests
  // autofocus. Preventing both paths keeps mobile keyboards closed until the user taps search.
  event.preventDefault();
}
</script>

<template>
  <ModelSelector v-model:open="selectorOpen">
    <ModelSelectorTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        class="min-w-0 max-w-full gap-1.5 px-1.5 text-sm font-normal text-ink-secondary hover:bg-canvas-soft sm:gap-2 sm:px-2 md:text-base"
        data-testid="model-select"
        :data-model-provider="activeModelProvider ?? ''"
        :disabled="loadingModels || !models.length"
      >
        <span class="flex min-w-0 items-center gap-1.5 sm:hidden">
          <span class="truncate text-ink">{{
            loadingModels
              ? t("app.loadingModels")
              : triggerModelLabel(activeModelLabel, hostDefaultModelLabel)
          }}</span>
          <span v-if="activeEffortCompactLabel" class="shrink-0 text-ink-muted">
            {{ activeEffortCompactLabel }}
          </span>
        </span>
        <span class="hidden truncate text-ink sm:inline">{{
          loadingModels
            ? t("app.loadingModels")
            : triggerModelLabel(activeModelLabel, hostDefaultModelLabel)
        }}</span>
        <span v-if="activeEffortCompactLabel" class="hidden shrink-0 text-ink-muted sm:inline">
          {{ activeEffortCompactLabel }}
        </span>
        <span
          v-if="activeModelProviderLabel"
          class="max-w-24 truncate rounded bg-canvas-soft px-1.5 py-0.5 text-xs text-ink-muted"
          :title="activeModelProviderLabel"
        >
          {{ activeModelProviderLabel }}
        </span>
        <ChevronDownIcon class="size-4 text-ink-muted" />
      </Button>
    </ModelSelectorTrigger>
    <ModelSelectorContent
      :title="t('app.model')"
      class="w-[min(92vw,32rem)] overflow-hidden rounded-2xl border-hairline shadow-xl shadow-ink/10"
      close-button-test-id="model-selector-close"
      data-testid="model-selector-dialog"
      @open-auto-focus="preventInitialFocus"
    >
      <ModelSelectorInput :auto-focus="false" :placeholder="t('app.searchModels')" />
      <ModelSelectorList class="max-h-[min(60dvh,28rem)] p-1">
        <ModelSelectorEmpty>{{ t("app.noMatchingModels") }}</ModelSelectorEmpty>
        <ModelSelectorGroup
          v-if="canSelectProvider && providerOptions.length > 1"
          :heading="t('app.agentProvider')"
        >
          <ModelSelectorItem
            v-for="option in providerOptions"
            :key="option.id"
            :value="`provider:${option.id}`"
            class="min-h-11 rounded-lg px-3 text-sm text-ink"
            :data-testid="`agent-provider-option-${option.id}`"
            @select="emit('selectProvider', option.id)"
          >
            <span>{{ providerLabel(option) }}</span>
            <CheckIcon v-if="option.id === selectedProvider" class="ml-auto size-4 text-primary" />
          </ModelSelectorItem>
        </ModelSelectorGroup>
        <ModelSelectorSeparator
          v-if="canSelectProvider && providerOptions.length > 1"
          class="my-1"
        />
        <ModelSelectorGroup :heading="t('app.reasoningEffort')">
          <ModelSelectorItem
            value="effort:default"
            data-testid="effort-option-default"
            class="min-h-11 rounded-lg px-3 text-sm text-ink"
            @select="selectEffort('default')"
          >
            <span>{{ t("app.effortHostDefault") }}</span>
            <span v-if="hostDefaultEffortLabel" class="ml-1.5 text-xs text-ink-muted">
              {{ hostDefaultEffortLabel }}
            </span>
            <CheckIcon v-if="activeEffortValue === ''" class="ml-auto size-4 text-primary" />
          </ModelSelectorItem>
          <ModelSelectorItem
            v-for="option in effortOptions"
            :key="option.value"
            :value="`effort:${option.value}`"
            class="min-h-11 rounded-lg px-3 text-sm text-ink"
            @select="selectEffort(option.value)"
          >
            <span>{{ labelEffortOption(option) }}</span>
            <CheckIcon
              v-if="option.value === activeEffortValue"
              class="ml-auto size-4 text-primary"
            />
          </ModelSelectorItem>
        </ModelSelectorGroup>
        <ModelSelectorSeparator class="my-1" />
        <ModelSelectorGroup v-if="canSelectProvider" :heading="t('app.model')">
          <ModelSelectorItem
            value="model:host-default"
            data-testid="model-option-host-default"
            class="min-h-11 rounded-lg px-3 text-sm text-ink"
            @select="selectModel({ model: '', modelProvider: null })"
          >
            <span class="truncate">{{ t("app.modelHostDefault") }}</span>
            <span
              v-if="hostDefaultModelLabel"
              class="ml-1.5 shrink-0 truncate text-xs text-ink-muted"
            >
              {{ hostDefaultModelLabel }}
            </span>
            <CheckIcon v-if="activeModel === ''" class="ml-auto size-4 text-primary" />
          </ModelSelectorItem>
        </ModelSelectorGroup>
        <p
          v-if="!canSelectProvider && modelGroups.some((group) => providerIsLocked(group.provider))"
          class="px-4 py-2 text-xs text-ink-muted"
          data-testid="model-provider-lock-hint"
        >
          {{ t("app.modelProviderLocked") }}
        </p>
        <ModelProviderGroup
          v-for="group in modelGroups"
          :key="JSON.stringify(group.provider)"
          :provider="group.provider"
          :label="group.label"
          :models="group.models"
          :active-model="activeModel"
          :active-model-provider="activeModelProvider"
          :expanded="providerIsExpanded(group.provider)"
          :locked="providerIsLocked(group.provider)"
          @toggle="toggleProvider(group.provider)"
          @select-model="selectModel"
        />
      </ModelSelectorList>
    </ModelSelectorContent>
  </ModelSelector>
</template>
