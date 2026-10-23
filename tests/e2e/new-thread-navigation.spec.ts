import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { installRealtimeSocketProbe } from "./helpers/realtime-socket-probe";

test("a delayed first-message creation cannot send into a different workspace", async ({
  page,
  remoteWorkspace,
}) => {
  let holdStart = false;
  const heldResults: Array<() => void> = [];
  // Delay a real successful SSH/app-server response, preserving its payload and all other traffic.
  await page.routeWebSocket(/\/api\/realtime$/, (route) => {
    const upstream = route.connectToServer();
    route.onMessage((raw) => upstream.send(raw));
    upstream.onMessage((raw) => {
      const message: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      const started = z.object({ type: z.literal("thread.started"), requestId: z.string() });
      if (holdStart && started.safeParse(message).success) heldResults.push(() => route.send(raw));
      else route.send(raw);
    });
  });
  await installRealtimeSocketProbe(page);
  await openApp(page, { interceptRealtime: false });
  const { host, project } = await remoteWorkspace.provision();
  const other = await remoteWorkspace.addProject(host.id, "Other workspace", "/tmp");
  await page.getByTestId(`project-button-${project.id}`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建", exact: true }).click();
  await expect(page.getByTestId("new-thread-draft")).toBeVisible();
  await expect(page.getByTestId("model-select")).toBeEnabled();
  const editor = page.getByPlaceholder("输入后续修改要求");
  await editor.fill("This draft must not be sent after changing workspaces.");
  holdStart = true;
  await page.getByTestId("send-turn-button").click();
  await expect.poll(() => heldResults.length).toBe(1);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.getByTestId("send-turn-button")).toBeDisabled();
  await page.getByTestId(`project-button-${other.id}`).click();
  await expect(page.getByTestId("project-thread-list")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("projectId")).toBe(String(other.id));
  holdStart = false;
  for (const release of heldResults.splice(0)) release();
  // Re-enabling the editor proves the pending submit settled after processing the real response.
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor).toHaveAttribute("data-value", "");
  expect(new URL(page.url()).searchParams.get("threadId")).toBeNull();
  expect(new URL(page.url()).searchParams.get("projectId")).toBe(String(other.id));
  const messages = await page.evaluate(() => window.__gatewayRealtimeProbe?.messages ?? []);
  expect(messages.filter((message) => message.type === "thread.start")).toHaveLength(1);
  expect(messages.filter((message) => message.type === "turn.start")).toEqual([]);
});
