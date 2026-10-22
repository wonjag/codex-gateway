export interface ModelRecord {
  id: string;
  model: string;
  /** Native Codex model provider; together with model this identifies a picker route. */
  modelProvider?: string | null;
  providerDisplayName?: string;
  displayName: string;
  description?: string | null;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  modelSpecialty?: string | null;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description?: string | null;
  }>;
  inputModalities?: string[];
  multiAgentVersion?: "disabled" | "v1" | "v2" | null;
  upgradeInfo?: {
    model: string;
    upgradeCopy: string | null;
    modelLink: string | null;
    migrationMarkdown: string | null;
    retirementAt: number | null;
  } | null;
}

export interface ModelListResult {
  data: ModelRecord[];
  nextCursor?: string | null;
  defaultModelProvider?: string | null;
}
