<script setup lang="ts">
import { CheckIcon, ChevronDownIcon, LockKeyholeIcon } from "@lucide/vue";
import { computed, useId } from "vue";
import type { ModelRecord } from "~~/shared/types";
import { ModelSelectorGroup, ModelSelectorItem } from "@codex-gateway/ai-elements/model-selector";
import { Button } from "@codex-gateway/ui/button";
import { useCommand } from "@codex-gateway/ui/command";
import { modelSelection, modelSelectionKey, type ModelSelection } from "@/utils/model-selection";

const props = defineProps<{
  provider: string | null;
  label: string;
  models: ModelRecord[];
  activeModel: string;
  activeModelProvider: string | null;
  expanded: boolean;
  locked: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  selectModel: [selection: ModelSelection];
}>();

const { t } = useI18n();
const { filterState } = useCommand();
const contentId = useId();
const isSearching = computed(() => filterState.search.trim() !== "");
const isExpanded = computed(() => isSearching.value || props.expanded);
const providerTestId = computed(() => props.provider ?? "default");

function isSelected(model: ModelRecord) {
  const selection = modelSelection(model);
  return (
    selection.model === props.activeModel &&
    (selection.modelProvider === null || selection.modelProvider === props.activeModelProvider)
  );
}
</script>

<template>
  <ModelSelectorGroup
    :data-testid="`model-provider-group-${providerTestId}`"
    :data-model-provider="provider ?? ''"
    :aria-label="label"
  >
    <Button
      type="button"
      variant="ghost"
      class="min-h-11 w-full justify-start gap-2 rounded-lg px-3 text-sm font-medium text-ink-secondary"
      :data-testid="`model-provider-toggle-${providerTestId}`"
      :aria-expanded="isExpanded"
      :aria-controls="contentId"
      :aria-label="
        t(isExpanded ? 'app.collapseModelProvider' : 'app.expandModelProvider', { provider: label })
      "
      :aria-disabled="isSearching || undefined"
      @click="!isSearching && emit('toggle')"
      @keydown.enter.stop
      @keydown.space.stop
    >
      <ChevronDownIcon
        class="size-4 shrink-0 transition-transform"
        :class="{ '-rotate-90': !isExpanded }"
      />
      <span class="min-w-0 truncate">{{ label }}</span>
      <span class="shrink-0 text-xs font-normal text-ink-muted">{{ models.length }}</span>
      <LockKeyholeIcon
        v-if="locked"
        class="ml-auto size-3.5 shrink-0 text-ink-muted"
        :aria-label="t('app.modelProviderLocked')"
      />
    </Button>
    <!-- Keep collapsed options registered with Command so search can reveal every provider. -->
    <div :id="contentId" v-show="isExpanded">
      <ModelSelectorItem
        v-for="model in models"
        :key="modelSelectionKey(modelSelection(model))"
        :value="`model:${modelSelectionKey(modelSelection(model))}`"
        :data-testid="`model-option-${modelSelection(model).model}`"
        :data-model-key="modelSelectionKey(modelSelection(model))"
        :data-model-provider="provider ?? ''"
        :data-model-selected="isSelected(model)"
        :disabled="locked || !isExpanded"
        class="min-h-11 rounded-lg py-2 pr-3 pl-9 text-sm text-ink"
        @select="emit('selectModel', modelSelection(model))"
      >
        <span class="truncate">{{ model.displayName || model.model || model.id }}</span>
        <span hidden aria-hidden="true">{{ label }} {{ provider }} {{ model.model }}</span>
        <CheckIcon v-if="isSelected(model)" class="ml-auto size-4 text-primary" />
      </ModelSelectorItem>
    </div>
  </ModelSelectorGroup>
</template>
