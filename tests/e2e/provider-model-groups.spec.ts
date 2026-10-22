import { randomUUID } from "node:crypto";
import { devices, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp, reloadApp } from "./helpers/app";
import { sendRealtimeRawRequest } from "./helpers/realtime";
import {
  installRealtimeSocketProbe,
  realtimeClientMessageCount,
  waitForRealtimeClientMessage,
} from "./helpers/realtime-socket-probe";
import { waitForSelectedThreadId, type UiProject } from "./helpers/remote-codex";
import {
  forkSettings,
  nameForkSource,
  nativeForkTimeline,
  sendCompletedForkTurn,
} from "./helpers/thread-fork";

const groupConfiguration = process.env.E2E_MODEL_GROUPS?.trim() ?? "";
const commonModel = process.env.E2E_CODEX_MODEL ?? "gpt-6-astra";
const providers = ["openai", "sub2api"] as const;
type ModelProvider = (typeof providers)[number];
const groupSchema = z.object({
  userId: z.number().int().positive(),
  hostId: z.number().int().positive(),
  modelProvider: z.string().min(1),
  displayName: z.string().min(1),
  models: z.array(z.string().min(1)),
});
const modelListSchema = z.object({
  defaultModelProvider: z.string().min(1),
  nextCursor: z.string().min(1).nullable().optional(),
  data: z.array(
    z.object({
      id: z.string().min(1),
      model: z.string().min(1),
      modelProvider: z.string().min(1),
      providerDisplayName: z.string().min(1),
    }),
  ),
});

test.describe("provider model groups", () => {
  test.skip(groupConfiguration === "", "Requires explicit E2E_MODEL_GROUPS and isolated auth");

  test("groups duplicate native models and preserves provider selection in new threads", async ({
    page,
    remoteWorkspace,
  }) => {
    test.setTimeout(8 * 60_000);
    await installRealtimeSocketProbe(page);
    await openApp(page);
    const { host, project } = await remoteWorkspace.provision({
      hostName: `model-groups-${Date.now()}`,
    });
    const groups = configuredGroups(host.id);
    const models = await authenticatedFetch(
      page,
      { url: `/api/models?hostId=${host.id}` },
      (value) => modelListSchema.parse(value),
    );
    expect(models.defaultModelProvider).toBe("openai");
    expect(models.data).toHaveLength(
      groups.reduce((count, group) => count + group.models.length, 0),
    );
    expect(
      new Set(models.data.map((model) => JSON.stringify([model.modelProvider, model.model]))).size,
    ).toBe(models.data.length);
    expect(models.data.filter((model) => model.model === commonModel)).toHaveLength(2);
    for (const provider of providers) {
      const group = groups.find((candidate) => candidate.modelProvider === provider)!;
      expect(
        models.data.find(
          (model) => model.modelProvider === provider && model.model === commonModel,
        ),
      ).toMatchObject({
        id: commonModel,
        model: commonModel,
        modelProvider: provider,
        providerDisplayName: group.displayName,
      });
    }

    // Page boundaries apply to provider/model pairs: the duplicate GPT slug must not disappear
    // when a page contains only one model, and the final provider must terminate its cursor.
    const pagedModels: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ hostId: String(host.id), limit: "1" });
      if (cursor !== null) query.set("cursor", cursor);
      const result = await authenticatedFetch(page, { url: `/api/models?${query}` }, (value) =>
        modelListSchema.parse(value),
      );
      expect(result.defaultModelProvider).toBe("openai");
      expect(result.data).toHaveLength(1);
      const model = result.data[0]!;
      pagedModels.push(JSON.stringify([model.modelProvider, model.model]));
      expect(pagedModels.length).toBeLessThanOrEqual(models.data.length);
      cursor = result.nextCursor ?? null;
      if (cursor !== null) {
        expect(cursors.has(cursor), "Provider model cursor must advance").toBe(false);
        cursors.add(cursor);
      }
    } while (cursor !== null);
    expect(new Set(pagedModels).size).toBe(models.data.length);
    expect(pagedModels.sort()).toEqual(
      models.data.map((model) => JSON.stringify([model.modelProvider, model.model])).sort(),
    );

    await openDraft(page, project);
    await page.getByTestId("model-select").click();
    const search = page
      .getByTestId("model-selector-dialog")
      .getByRole("textbox", { name: "搜索模型或推理强度" });
    await expect(providerToggle(page, "openai")).toHaveAttribute("aria-expanded", "true");
    await expect(providerToggle(page, "sub2api")).toHaveAttribute("aria-expanded", "false");
    await providerToggle(page, "openai").click();
    await expect(providerOption(page, "openai")).toBeHidden();
    await providerToggle(page, "sub2api").focus();
    await page.keyboard.press("Enter");
    await expect(providerOption(page, "sub2api")).toBeVisible();
    await page.keyboard.press("Space");
    await expect(providerOption(page, "sub2api")).toBeHidden();
    await page.keyboard.press("Space");
    await expect(providerOption(page, "sub2api")).toBeVisible();

    // Both copies must be searchable even when their group was collapsed. Clearing the query
    // restores the user's independent collapse choices, rather than keeping every group open.
    await search.fill(commonModel);
    await expect(providerOption(page, "openai")).toBeVisible();
    await expect(providerOption(page, "sub2api")).toBeVisible();
    await test.info().attach("desktop-provider-groups", {
      body: await page.screenshot({ path: test.info().outputPath("desktop-provider-groups.png") }),
      contentType: "image/png",
    });
    await search.fill("sub2api");
    await expect(providerOption(page, "sub2api")).toBeVisible();
    await expect(providerOption(page, "openai")).toBeHidden();
    await search.fill("model-that-does-not-exist-e2e");
    await expect(page.getByText("没有匹配的模型或推理强度", { exact: true })).toBeVisible();
    await search.fill("");
    await expect(providerToggle(page, "openai")).toHaveAttribute("aria-expanded", "false");
    await expect(providerToggle(page, "sub2api")).toHaveAttribute("aria-expanded", "true");
    await providerOption(page, "sub2api").click();
    await expect(providerOption(page, "sub2api")).toHaveAttribute("data-model-selected", "true");
    await page.getByTestId("model-selector-close").click();
    const sub2apiThread = await startSelectedThread(page, project, "sub2api");
    await assertStartedThreadSettings(page, project, sub2apiThread, "sub2api");
    await assertExistingProviderLocked(page, "sub2api");

    // The identical slug in a different group must create a genuinely different native route.
    const authThread = await startProviderThread(page, project, "openai");
    expect(authThread).not.toBe(sub2apiThread);
    await assertStartedThreadSettings(page, project, authThread, "openai");
    await assertExistingProviderLocked(page, "openai");

    const invalid = await sendRealtimeRawRequest(page, {
      type: "thread.start",
      requestId: randomUUID(),
      hostId: host.id,
      projectId: project.id,
      model: commonModel,
      modelProvider: "e2e-unconfigured-provider",
    });
    expect(invalid).toMatchObject({ type: "error", code: "MODEL_ROUTE_INVALID" });
  });

  test("completes real turns and preserves each provider across settings changes and desktop/mobile refresh", async ({
    browser,
    page,
    remoteWorkspace,
  }) => {
    test.skip(process.env.E2E_CODEX_TURN !== "1", "Requires E2E_CODEX_TURN=1 for real model calls");
    test.setTimeout(10 * 60_000);
    await installRealtimeSocketProbe(page);
    await openApp(page);
    const { host, project } = await remoteWorkspace.provision({
      hostName: `model-provider-turns-${Date.now()}`,
    });
    configuredGroups(host.id);
    for (const provider of providers) {
      const threadId = await startProviderThread(page, project, provider);
      const scope = { hostId: host.id, threadId };
      await nameForkSource(page, scope, `E2E ${provider} provider route`);
      const marker = `PROVIDER_${provider}_${randomUUID().replaceAll("-", "")}`;
      const turnId = await sendCompletedForkTurn(
        page,
        `Reply exactly ${marker}. Do not use tools.`,
      );
      const { entries } = await nativeForkTimeline(page, scope);
      expect(
        entries.some((entry) => entry.type === "turnCompleted" && entry.turnId === turnId),
      ).toBe(true);
      expect(
        entries.some(
          (entry) =>
            entry.type === "item" &&
            entry.turnId === turnId &&
            entry.item.type === "agentMessage" &&
            typeof entry.item.text === "string" &&
            entry.item.text.includes(marker),
        ),
      ).toBe(true);
      expect(await forkSettings(page, scope)).toMatchObject({
        model: commonModel,
        modelProvider: provider,
      });
      await assertExistingProviderLocked(page, provider);
      await assertProviderChangeRejected(
        page,
        project,
        threadId,
        provider === "openai" ? "sub2api" : "openai",
      );
      // A completed real turn creates the native rollout required by settings recovery. Null
      // Option fields and /plan must preserve its model/provider, including the non-default route.
      await authenticatedFetch(
        page,
        {
          url: "/api/threads/settings",
          method: "POST",
          body: { ...scope, model: null, modelProvider: null },
        },
        (value) => value,
      );
      expect(await forkSettings(page, scope)).toMatchObject({
        model: commonModel,
        modelProvider: provider,
      });
      await page.getByPlaceholder("输入后续修改要求").fill("/plan");
      await page.getByTestId("slash-command-plan").click();
      await expect
        .poll(async () => (await forkSettings(page, scope)).collaborationMode?.mode)
        .toBe("plan");
      const persistedSettings = {
        model: commonModel,
        modelProvider: provider,
        collaborationMode: { mode: "plan", settings: { model: commonModel } },
      };
      expect(await forkSettings(page, scope)).toMatchObject(persistedSettings);
      await reloadApp(page);
      expect(await forkSettings(page, scope)).toMatchObject(persistedSettings);
      await expect(page.getByTestId("model-select")).toHaveAttribute(
        "data-model-provider",
        provider,
      );
      await assertExistingProviderLocked(page, provider);

      const mobileContext = await browser.newContext({
        ...devices["Pixel 5"],
        viewport: { width: 375, height: 812 },
        storageState: await page.context().storageState(),
      });
      try {
        const mobile = await mobileContext.newPage();
        await openApp(mobile, { resetConfig: false });
        await expect(mobile.getByTestId("mobile-layout")).toBeVisible();
        await expect(mobile.getByTestId("model-select")).toHaveAttribute(
          "data-model-provider",
          provider,
        );
        await assertExistingProviderLocked(mobile, provider, true);
        await reloadApp(mobile);
        await expect(mobile.getByTestId("model-select")).toHaveAttribute(
          "data-model-provider",
          provider,
        );
        await assertExistingProviderLocked(mobile, provider, true);
        expect(await forkSettings(mobile, scope)).toMatchObject(persistedSettings);
      } finally {
        await mobileContext.close();
      }
      await test.info().attach(`provider-${provider}-completed-turn`, {
        body: JSON.stringify({ threadId, turnId, model: commonModel, modelProvider: provider }),
        contentType: "application/json",
      });
    }
  });
});

function configuredGroups(hostId: number) {
  const groups = z
    .array(groupSchema)
    .parse(JSON.parse(groupConfiguration))
    .filter((group) => group.userId === 1 && group.hostId === hostId);
  // Each test resets the real Gateway user config. Its first host has id 1, matching the
  // explicit test-only allowlist; no production host or app-server is ever reconfigured.
  expect(hostId).toBe(1);
  for (const provider of providers) {
    expect(groups.find((group) => group.modelProvider === provider)?.models).toContain(commonModel);
  }
  return groups;
}

function providerToggle(page: Page, provider: ModelProvider) {
  return page.getByTestId(`model-provider-toggle-${provider}`);
}

function providerOption(page: Page, provider: ModelProvider): Locator {
  return page
    .getByTestId(`model-provider-group-${provider}`)
    .getByTestId(`model-option-${commonModel}`);
}

async function expandProvider(page: Page, provider: ModelProvider) {
  if ((await providerToggle(page, provider).getAttribute("aria-expanded")) !== "true") {
    await providerToggle(page, provider).click();
  }
  await expect(providerOption(page, provider)).toBeVisible();
}

async function openDraft(page: Page, project: UiProject) {
  await page.goto(`/?hostId=${project.hostId}&projectId=${project.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const navigation = window.__codexGatewayE2e?.navigation;
        return navigation === undefined
          ? null
          : { projectId: navigation.selectedProjectId, threadId: navigation.selectedThreadId };
      }),
    )
    .toEqual({ projectId: project.id, threadId: null });
  await expect(page.getByTestId("model-select")).toBeEnabled();
}

async function startProviderThread(page: Page, project: UiProject, provider: ModelProvider) {
  await openDraft(page, project);
  await page.getByTestId("model-select").click();
  await expandProvider(page, provider);
  await providerOption(page, provider).click();
  await page.getByTestId("model-selector-close").click();
  return await startSelectedThread(page, project, provider);
}

async function startSelectedThread(page: Page, project: UiProject, provider: ModelProvider) {
  await expect(page.getByTestId("model-select")).toHaveAttribute("data-model-provider", provider);
  const offset = await realtimeClientMessageCount(page);
  await page.getByPlaceholder("输入后续修改要求").fill("/");
  await page.getByTestId("slash-command-new").click();
  const threadId = await waitForSelectedThreadId(page);
  expect(await waitForRealtimeClientMessage(page, "thread.start", offset)).toMatchObject({
    hostId: project.hostId,
    projectId: project.id,
    model: commonModel,
    modelProvider: provider,
  });
  await expect(page.getByPlaceholder("输入后续修改要求")).toBeEditable();
  return threadId;
}

async function assertStartedThreadSettings(
  page: Page,
  project: UiProject,
  threadId: string,
  provider: ModelProvider,
) {
  // Before the first turn native Codex has no rollout and explicitly rejects thread/resume.
  // Read the real thread/start response projected into the browser; the real-turn scenario below
  // separately verifies persisted settings through the authoritative settings recovery RPC.
  await expect
    .poll(() =>
      page.evaluate(
        ({ hostId, threadId }) => {
          const driver = window.__codexGatewayE2e;
          if (
            driver?.views.currentThread?.id !== threadId ||
            driver.views.currentThread.hostId !== hostId
          ) {
            return null;
          }
          return {
            modelProvider: driver.views.currentThread.modelProvider,
            settings: driver.composer.threadSettingsByKey[`${hostId}:${threadId}`],
          };
        },
        { hostId: project.hostId, threadId },
      ),
    )
    .toMatchObject({
      modelProvider: provider,
      settings: { model: commonModel, modelProvider: provider },
    });
}

async function assertExistingProviderLocked(page: Page, provider: ModelProvider, mobile = false) {
  await page.getByTestId("model-select").click();
  const dialog = page.getByTestId("model-selector-dialog");
  await expect(page.getByTestId("model-provider-lock-hint")).toBeVisible();
  await expect(page.getByTestId("model-option-host-default")).toHaveCount(0);
  await expandProvider(page, provider);
  await expect(providerOption(page, provider)).toHaveAttribute("data-model-selected", "true");
  const otherProvider = provider === "openai" ? "sub2api" : "openai";
  await expandProvider(page, otherProvider);
  await expect(providerOption(page, otherProvider)).toHaveAttribute("data-disabled", "");
  await expect(providerOption(page, otherProvider)).toHaveAttribute("data-model-selected", "false");
  if (mobile) {
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (box === null || viewport === null) throw new Error("Missing mobile viewport geometry");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    await providerOption(page, otherProvider).scrollIntoViewIfNeeded();
    await expect(providerOption(page, otherProvider)).toBeInViewport();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await test.info().attach("mobile-provider-groups", {
      body: await page.screenshot({ path: test.info().outputPath("mobile-provider-groups.png") }),
      contentType: "image/png",
    });
  }
  await page.getByTestId("model-selector-close").click();
}

async function assertProviderChangeRejected(
  page: Page,
  project: UiProject,
  threadId: string,
  otherProvider: ModelProvider,
) {
  const response = await page.evaluate(
    async (body) => {
      const token = localStorage.getItem("codex-gateway-auth-token");
      if (token === null || token === "") throw new Error("Missing E2E Gateway auth token");
      const result = await fetch("/api/threads/settings", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await result.json();
      return { status: result.status, payload };
    },
    { hostId: project.hostId, threadId, model: commonModel, modelProvider: otherProvider },
  );
  expect(response).toMatchObject({ status: 409, payload: { code: "MODEL_PROVIDER_MISMATCH" } });
  const turn = await sendRealtimeRawRequest(page, {
    type: "turn.start",
    requestId: randomUUID(),
    hostId: project.hostId,
    projectId: project.id,
    threadId,
    model: commonModel,
    modelProvider: otherProvider,
    text: "Reply exactly REJECTED_PROVIDER_CHANGE without using tools.",
  });
  expect(turn).toMatchObject({ type: "error", code: "MODEL_PROVIDER_MISMATCH" });
}
