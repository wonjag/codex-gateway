<script setup lang="ts">
import { CalendarClockIcon } from "@lucide/vue";
import { computed } from "vue";
import { formatTurnCompletedAt } from "@/utils/turn-timing";

const props = defineProps<{
  completedAt: number | null;
  dataTestId?: string;
}>();

const { t } = useI18n();
const label = computed(() => formatTurnCompletedAt(props.completedAt));
</script>

<template>
  <span
    v-if="label !== null"
    class="inline-flex min-w-0 items-start gap-1.5 text-xs leading-5 text-ink-faint"
    :data-testid="dataTestId"
  >
    <CalendarClockIcon aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
    <span>{{ t("app.turnCompletedAt", { time: label }) }}</span>
  </span>
</template>
