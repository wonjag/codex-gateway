export interface TurnTiming {
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface DisplayedTurnTiming extends TurnTiming {
  active: boolean;
}

const beijingDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Format an app-server Unix timestamp (seconds) in a browser-independent Beijing timezone. */
export function formatTurnCompletedAt(completedAt: number | null) {
  if (completedAt === null || !Number.isFinite(completedAt)) return null;
  const date = new Date(completedAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    beijingDateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  if (
    parts.year === undefined ||
    parts.month === undefined ||
    parts.day === undefined ||
    parts.hour === undefined ||
    parts.minute === undefined ||
    parts.second === undefined
  )
    return null;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function resolvedTurnDurationMs(timing: TurnTiming, nowMs: number) {
  if (timing.durationMs !== null && Number.isFinite(timing.durationMs)) {
    return Math.max(0, timing.durationMs);
  }
  if (timing.startedAt === null || !Number.isFinite(timing.startedAt)) return null;
  const startedAtMs = timing.startedAt * 1000;
  const completedAtMs =
    timing.completedAt === null || !Number.isFinite(timing.completedAt)
      ? nowMs
      : timing.completedAt * 1000;
  return Math.max(0, completedAtMs - startedAtMs);
}
