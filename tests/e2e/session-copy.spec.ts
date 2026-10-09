import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";

const clipboardBaseUrl = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100");
clipboardBaseUrl.hostname = "127.0.0.1";

test.use({
  baseURL: clipboardBaseUrl.origin,
  permissions: ["clipboard-read", "clipboard-write"],
});

test("copies a session path from the session page and sidebar menu", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  const { project } = await remoteWorkspace.provision({ projectName: "复制工作空间" });
  const threadId = await remoteWorkspace.startThread(project.id);

  await expect(page.getByTestId(`thread-button-${threadId}`)).toBeVisible();
  await page.getByTestId(`thread-button-${threadId}`).click();
  await expect(page.getByTestId("session-header")).toBeVisible();
  const sessionName = (await page.getByTestId("session-header-name").innerText()).trim();
  const expected = `workspace中${project.name}名为${sessionName}的session`;

  await page.getByTestId("copy-session-path").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

  await page.getByTestId(`thread-button-${threadId}`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制session路径", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
});
