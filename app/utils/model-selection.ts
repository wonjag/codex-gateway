import type { ModelRecord } from "~~/shared/types";
import { trimmedOrFallback, trimmedOrNull } from "~~/shared/utils/strings";

export interface ModelSelection {
  model: string;
  modelProvider: string | null;
}

export function modelSelection(model: ModelRecord): ModelSelection {
  return {
    model: trimmedOrFallback(model.model, model.id),
    modelProvider: trimmedOrNull(model.modelProvider),
  };
}

export function modelSelectionKey(selection: ModelSelection) {
  return JSON.stringify([selection.modelProvider, selection.model]);
}
