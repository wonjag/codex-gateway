import { ref, watch, type ComputedRef } from "vue";

interface IntermediateDisclosureTurn {
  id: string;
}

export function useIntermediateStepsDisclosure(input: {
  turns: ComputedRef<IntermediateDisclosureTurn[]>;
  threadIsRunning: ComputedRef<boolean>;
  activeTurnId: ComputedRef<string | null>;
  autoCollapseIntermediate: ComputedRef<boolean>;
}) {
  // A timeline is an accordion, not a set of independent disclosures. Keeping one id prevents
  // concurrent/continued Turns from mounting every intermediate stream at once, while locating the
  // state above virtual rows preserves it when offscreen rows are destroyed and recreated.
  const openTurnId = ref<string | null>(null);
  const userSelectedTurnId = ref<string | null>(null);

  watch(
    () => [
      input.threadIsRunning.value,
      input.activeTurnId.value,
      input.autoCollapseIntermediate.value,
      ...input.turns.value.map((turn) => turn.id),
    ],
    () => {
      const turns = input.turns.value;
      const liveTurnIds = new Set(turns.map((turn) => turn.id));
      if (userSelectedTurnId.value !== null && !liveTurnIds.has(userSelectedTurnId.value)) {
        userSelectedTurnId.value = null;
      }
      if (openTurnId.value !== null && !liveTurnIds.has(openTurnId.value)) {
        openTurnId.value = null;
      }

      if (userSelectedTurnId.value !== null) {
        openTurnId.value = userSelectedTurnId.value;
        return;
      }

      if (input.threadIsRunning.value) {
        // Runtime already owns the authoritative active Turn used by steer/interrupt. A paged
        // timeline can omit turnStarted, and a pause between items need not contain any running
        // item. Re-inferring activity here makes an optimistic steer close the accordion when
        // sending restores bottom-follow, then reopen on the next Agent delta. Keep disclosure
        // policy here, using runtime identity; neither the composer nor item presenters own it.
        const activeTurnId = input.activeTurnId.value;
        if (activeTurnId !== null && liveTurnIds.has(activeTurnId)) {
          openTurnId.value = activeTurnId;
        }
      } else if (input.autoCollapseIntermediate.value) {
        openTurnId.value = null;
      }
    },
    { immediate: true },
  );

  function isIntermediateOpen(turnId: string) {
    return openTurnId.value === turnId;
  }

  function setIntermediateOpen(turnId: string, open: boolean) {
    // A click is the user's explicit accordion selection, regardless of whether the Turn is still
    // streaming. It remains the sole open Turn until the user closes it or it leaves the retained
    // timeline; another active Turn must never reopen alongside the one the user chose.
    userSelectedTurnId.value = open ? turnId : null;
    openTurnId.value = open ? turnId : null;
  }

  return {
    isIntermediateOpen,
    setIntermediateOpen,
  };
}
