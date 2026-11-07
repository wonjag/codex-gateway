import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp, reloadApp } from "./helpers/app";
import { nameForkSource, nativeForkTimeline, sendCompletedForkTurn } from "./helpers/thread-fork";
import { parseRealtimeServerMessage } from "../../shared/runtime/realtime";
import type { RealtimeServerMessage } from "../../shared/types";

test("0.167 accepts each send once and delivers terminal events before and after reconnect", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(8 * 60_000);
  const received: RealtimeServerMessage[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/realtime")) return;
    socket.on("framereceived", ({ payload }) => {
      received.push(parseRealtimeServerMessage(JSON.parse(payload.toString())));
    });
  });
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  await nameForkSource(page, scope, "Codex protocol regression");

  for (const index of [1, 2]) {
    const marker = `PROTOCOL_${index}_${randomUUID()}`;
    const offset = received.length;
    const turnId = await sendCompletedForkTurn(
      page,
      `Do not inspect files or use tools. Reply with only the following marker, without punctuation:\n${marker}`,
    );
    const messages = received.slice(offset);
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
    const accepted = messages.filter((message) => message.type === "turn.start.accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.turn).toMatchObject({ id: turnId, rootTurnId: turnId });
    for (const eventType of ["turn.started", "turn.completed"]) {
      expect(
        messages.some(
          (message) =>
            message.type === "thread.event" &&
            message.event.threadId === threadId &&
            message.event.event.type === eventType,
        ),
      ).toBe(true);
    }
    const timeline = await nativeForkTimeline(page, scope, 3);
    const userInputs = timeline.entries.filter(
      (entry) =>
        entry.type === "item" && entry.turnId === turnId && entry.item.type === "userMessage",
    );
    expect(userInputs).toHaveLength(1);
    expect(
      timeline.entries.some(
        (entry) =>
          entry.type === "item" &&
          entry.turnId === turnId &&
          entry.item.type === "agentMessage" &&
          typeof entry.item.text === "string" &&
          entry.item.text.trim() === marker,
      ),
    ).toBe(true);
    await reloadApp(page);
    await expect(page.getByTestId(`turn-completed-at-${turnId}`)).toBeVisible();
    await expect(page.getByTestId("send-turn-button")).not.toHaveAttribute(
      "aria-label",
      "停止生成",
    );
  }
});
