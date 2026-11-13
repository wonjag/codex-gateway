import {
  installRealtimeSocketProbe,
  realtimeClientMessageCount,
  waitForRealtimeClientMessage,
} from "./helpers/realtime-socket-probe";
import { sendRealtimeRequest } from "./helpers/realtime";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp, reloadApp } from "./helpers/app";
import { nameForkSource, nativeForkTimeline, sendCompletedForkTurn } from "./helpers/thread-fork";
import { parseRealtimeServerMessage } from "../../shared/runtime/realtime";
import type { RealtimeServerMessage } from "../../shared/types";

test("0.169 accepts each send once and delivers terminal events before and after reconnect", async ({
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

test("accepted turn survives a response decoder failure without duplicate input or false completion", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(8 * 60_000);
  const errors: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const value = parseRealtimeServerMessage(JSON.parse(payload.toString()));
      if (value.type === "error" && typeof value.code === "string") errors.push(value.code);
    });
  });
  await installRealtimeSocketProbe(page);
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  await nameForkSource(page, scope, "Accepted mutation decoding regression");
  await authenticatedFetch(
    page,
    {
      url: "/api/e2e/reject-turn-response",
      method: "POST",
      body: scope,
    },
    (value) => z.object({ armed: z.boolean() }).parse(value),
  );
  const marker = `ACCEPTED_ONCE_${randomUUID()}`;
  const offset = await realtimeClientMessageCount(page);
  // A known decoder error is expected; the native turn still finishes and stays readable.
  await sendCompletedForkTurn(page, `Do not use tools. Reply with only ${marker}`);
  await expect.poll(() => errors).toContain("turnDeliveryUncertain");
  expect(await waitForRealtimeClientMessage(page, "thread.activate", offset)).toMatchObject(scope);
  const timeline = await nativeForkTimeline(page, scope, 4);
  const inputs = timeline.entries.filter(
    (entry) => entry.type === "item" && entry.item.type === "userMessage",
  );
  expect(inputs).toHaveLength(1);
  await reloadApp(page);
  const restored = await nativeForkTimeline(page, scope, 4);
  expect(
    restored.entries.filter((entry) => entry.type === "item" && entry.item.type === "userMessage"),
  ).toHaveLength(1);
});

test("queue pauses accepted-but-undecodable delivery without sending it again", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(8 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const threadId = await remoteWorkspace.startThread(project.id);
  const scope = { hostId: host.id, threadId };
  await nameForkSource(page, scope, "Queue uncertain delivery regression");
  await authenticatedFetch(
    page,
    {
      url: "/api/e2e/reject-turn-response",
      method: "POST",
      body: scope,
    },
    (value) => z.object({ armed: z.boolean() }).parse(value),
  );
  const marker = `QUEUE_ONCE_${randomUUID()}`;
  const id = randomUUID();
  await sendRealtimeRequest(page, {
    type: "turn.queue",
    requestId: randomUUID(),
    ...scope,
    action: "enqueue",
    input: {
      ...scope,
      projectId: project.id,
      text: `Do not use tools. Reply with only ${marker}`,
      clientUserMessageId: id,
      model: remoteWorkspace.remote.testModel,
    },
  });
  const queue = async () => {
    const response = await sendRealtimeRequest(page, {
      type: "turn.queue",
      requestId: randomUUID(),
      ...scope,
      action: "list",
    });
    if (response.type !== "turn.queue.snapshot") throw new Error("Expected queue snapshot");
    return response.entries;
  };
  await expect
    .poll(queue, { timeout: 60_000 })
    .toEqual([
      expect.objectContaining({ id, status: "paused", pauseReason: "delivery_uncertain" }),
    ]);
  await expect
    .poll(
      async () => {
        const timeline = await nativeForkTimeline(page, scope, 4);
        return timeline.entries.some((entry) => entry.type === "turnCompleted");
      },
      { timeout: 180_000 },
    )
    .toBe(true);
  await reloadApp(page);
  expect(await queue()).toEqual([
    expect.objectContaining({ id, status: "paused", pauseReason: "delivery_uncertain" }),
  ]);
  const timeline = await nativeForkTimeline(page, scope, 4);
  expect(
    timeline.entries.filter((entry) => entry.type === "item" && entry.item.type === "userMessage"),
  ).toHaveLength(1);
});
