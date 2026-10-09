import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/remote-workspace";
import { appServerTurnFixture } from "./fixtures/app-server-turn";
import { openApp, reloadApp } from "./helpers/app";
import { gatewayEventFromNotification } from "./helpers/canonical-event";
import { applyGatewayLiveEvent, seedGatewayThread } from "./helpers/gateway-store";
import { nameForkSource, nativeForkTimeline, sendCompletedForkTurn } from "./helpers/thread-fork";

const turnId = "copy-turn";
const itemId = "copy-answer";
const copiedMessage = "代码已复制";
const failedMessage = "复制代码失败，请手动选择并复制";

async function seedMarkdown(page: Page, content: string, streaming = false) {
  const threadId = "code-block-copy-presentation";
  await seedGatewayThread(page, {
    threadId,
    currentThread: { id: threadId, name: "Code block copy presentation" },
    status: streaming ? "running" : "completed",
    history: {
      thread: {
        id: threadId,
        turns: [
          appServerTurnFixture({
            id: turnId,
            status: streaming ? "inProgress" : "completed",
            items: [
              {
                id: itemId,
                type: "agentMessage",
                phase: "final_answer",
                status: streaming ? "inProgress" : "completed",
                text: content,
              },
            ],
          }),
        ],
      },
    },
  });
  return threadId;
}

function blocks(page: Page) {
  return page.getByTestId("chat-scroll-area").locator(".markdown-code-block");
}

async function copyAndRead(page: Page, block: Locator, expected: string, keyboard = false) {
  const button = block.getByRole("button", { name: "复制代码", exact: true });
  await expect(button).toBeVisible();
  if (keyboard) {
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await button.click();
  }
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
}

// The runner shares the Gateway network namespace. Loopback provides a genuinely secure
// browser context for the native Clipboard API without changing Chromium security flags.
const clipboardBaseUrl = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100");
clipboardBaseUrl.hostname = "127.0.0.1";

test.describe("native browser clipboard", () => {
  test.use({
    baseURL: clipboardBaseUrl.origin,
    permissions: ["clipboard-read", "clipboard-write"],
  });

  // These focused presentation fixtures exercise difficult Markdown shapes and event ordering.
  // The final test below separately verifies real SSH/app-server/model history and restoration.
  test("copies each plain, shell, diff and indented block exactly on desktop and mobile", async ({
    page,
  }) => {
    await openApp(page);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    const contents = [
      "http://127.0.0.1:8080/files\n",
      "printf '%s\\n' '<tag a=\"b\">& value</tag>'\n\n  echo \"$VALUE\" `whoami`\n",
      "--- a/config.txt\n+++ b/config.txt\n@@ -1 +1 @@\n-old & value\n+new <value>\n",
      "first\n  nested\n\nlast\n",
    ];
    await seedMarkdown(
      page,
      [
        "Inline `not a block`.",
        `\`\`\`\n${contents[0]}\`\`\``,
        `\`\`\`sh\n${contents[1]}\`\`\``,
        `\`\`\`diff\n${contents[2]}\`\`\``,
        "    first\n      nested\n\n    last",
      ].join("\n\n"),
    );
    await expect(blocks(page)).toHaveCount(contents.length);
    await expect(page.getByRole("button", { name: "复制代码", exact: true })).toHaveCount(
      contents.length,
    );
    await expect(blocks(page).nth(2).locator(".diff-line-add")).toBeAttached();
    for (const [index, content] of contents.entries()) {
      await copyAndRead(page, blocks(page).nth(index), content, index === 0);
    }

    await page.setViewportSize({ width: 375, height: 812 });
    for (const [index, content] of contents.entries()) {
      const block = blocks(page).nth(index);
      await copyAndRead(page, block, content);
      const bounds = await block
        .getByRole("button", { name: "复制代码", exact: true })
        .boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    }
    await expect(page.getByText(copiedMessage, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("code-block-copy-mobile.png") });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("settings-toggle").click();
    await page.getByRole("tab", { name: "外观" }).click();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "English" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      blocks(page).first().getByRole("button", { name: "Copy code", exact: true }),
    ).toBeAttached();
  });

  test("copies the latest rendered content as an unfinished code fence streams and completes", async ({
    page,
  }) => {
    await openApp(page);
    const initial = "first <value> & $TOKEN\n";
    const threadId = await seedMarkdown(page, `\`\`\`sh\n${initial}`, true);
    await expect(blocks(page)).toHaveCount(1);
    await copyAndRead(page, blocks(page).first(), initial);
    const suffix = '\n  second "quoted"\n';
    await applyGatewayLiveEvent(
      page,
      gatewayEventFromNotification({
        id: 1,
        threadId,
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId, delta: `${suffix}\`\`\`` },
      }),
    );
    await expect(blocks(page).first().locator("pre code")).toContainText('second "quoted"');
    await copyAndRead(page, blocks(page).first(), initial + suffix);
    await applyGatewayLiveEvent(
      page,
      gatewayEventFromNotification({
        id: 2,
        threadId,
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            id: itemId,
            type: "agentMessage",
            phase: "final_answer",
            text: `\`\`\`sh\n${initial}${suffix}\`\`\``,
          },
        },
      }),
    );
    await expect(blocks(page).first().locator(".syntax-highlight")).toBeAttached();
    await copyAndRead(page, blocks(page).first(), initial + suffix);
  });

  test("copies a real model code block matching native history before and after reload", async ({
    page,
    remoteWorkspace,
  }) => {
    await openApp(page, { interceptRealtime: false });
    const { host, project } = await remoteWorkspace.provision();
    const threadId = await remoteWorkspace.startThread(project.id);
    const scope = { hostId: host.id, threadId };
    await nameForkSource(page, scope, "Native code block clipboard regression");
    const marker = `COPY_${randomUUID()}`;
    const content = `http://127.0.0.1:8080/files\n  <value>${marker}&ready</value>\n\nstatus=ready\n`;
    const completedTurnId = await sendCompletedForkTurn(
      page,
      `Without using tools, reply with exactly one Markdown code block with no language identifier and no prose. Copy the following content literally, preserving the two leading spaces on line 2 and the empty line:\n\n${content.trimEnd()}`,
    );
    const timeline = await nativeForkTimeline(page, scope);
    const nativeAnswers = timeline.entries.flatMap((entry) =>
      entry.type === "item" &&
      entry.turnId === completedTurnId &&
      entry.item.type === "agentMessage" &&
      typeof entry.item.text === "string"
        ? [entry.item.text]
        : [],
    );
    const nativeAnswer = nativeAnswers.find((text) => text.includes(marker));
    expect(
      nativeAnswer,
      "The official history must contain the requested native answer",
    ).toBeDefined();
    const nativeCode = nativeAnswer?.match(/```[^\r\n]*\r?\n([\s\S]*?)```/)?.[1];
    expect(nativeCode).toBe(content);
    const block = blocks(page).filter({ hasText: marker });
    await expect(block).toHaveCount(1);
    await copyAndRead(page, block, nativeCode!);
    await reloadApp(page);
    await expect(block).toHaveCount(1);
    await copyAndRead(page, block, nativeCode!);
    await page.screenshot({
      path: test.info().outputPath("native-code-block-copy-after-reload.png"),
    });
  });
});

test("plain HTTP uses a real browser copy event and reports denied or failed clipboard writes", async ({
  page,
}) => {
  await openApp(page);
  const content = "http://127.0.0.1:8080/files\n\n  <value>& copied</value>\n";
  await seedMarkdown(page, `\`\`\`\n${content}\`\`\``);
  // nip.io is the official Docker runner's HTTP origin, which does not expose Clipboard API.
  // Capture the browser's real copy event without intercepting execCommand or preventing it.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof navigator.clipboard)).toBe("undefined");
  const copied = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener(
          "copy",
          () => {
            const active = document.activeElement;
            resolve(
              active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
                ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
                : (window.getSelection()?.toString() ?? ""),
            );
          },
          { once: true },
        );
      }),
  );
  await blocks(page).first().getByRole("button", { name: "复制代码", exact: true }).click();
  expect(await copied).toBe(content);
  await expect(page.getByText(copiedMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(copiedMessage, { exact: true })).toBeHidden();

  // Simulate both API permission refusal and an unsupported legacy copy command. Neither may
  // display success; implementation error details must not expose the code being copied.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  await blocks(page).first().getByRole("button", { name: "复制代码", exact: true }).click();
  await expect(page.getByText(failedMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(copiedMessage, { exact: true })).toHaveCount(0);
  await expect(page.locator("textarea").filter({ hasText: "<value>" })).toHaveCount(0);
});
