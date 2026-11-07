import type { AppServerTurn } from "../../../shared/types";

export type AppServerTurnFixture = Pick<AppServerTurn, "id"> &
  Partial<Omit<AppServerTurn, "id" | "items">> & {
    items?: AppServerTurn["items"];
  };

export function appServerTurnFixture(fixture: AppServerTurnFixture): AppServerTurn {
  return {
    rootTurnId: null,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...fixture,
  };
}
