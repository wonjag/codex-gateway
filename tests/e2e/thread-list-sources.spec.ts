import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp } from "./helpers/app";
import { execRemoteSsh } from "./helpers/remote-codex";

const listResponseSchema = z.object({
  data: z.array(z.object({ id: z.string(), parentThreadId: z.string().nullable() }).loose()),
  nextCursor: z.string().nullable().optional(),
  projects: z.array(z.object({ remotePath: z.string() }).loose()),
});

test("main thread pagination excludes children while project discovery retains every source", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page);
  const host = await remoteWorkspace.addHost(`thread-sources-${Date.now()}`);
  const mainId = randomUUID();
  const cwd = `/tmp/thread-sources-${mainId}`;
  const childCwd = `${cwd}/child-only`;
  const childIds = Array.from({ length: 55 }, () => randomUUID());
  const entries = [mainId, ...childIds].map((id, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, 2, 3, 4, index)).toISOString();
    const child = index === 55;
    const threadCwd = index === 55 ? childCwd : cwd;
    const message = child ? `Child work ${index}` : "Original main session name";
    const records = [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id,
          session_id: id,
          timestamp,
          cwd: threadCwd,
          originator: "codex",
          cli_version: "0.160.0",
          model_provider: "openai",
          parent_thread_id: child ? mainId : null,
          source: child
            ? {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: mainId,
                    depth: 1,
                    // Native AgentPath segments allow lowercase letters, digits, and underscores.
                    agent_path: `/root/child_${index}`,
                    agent_nickname: null,
                    agent_role: null,
                  },
                },
              }
            : "cli",
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: message }],
        },
      },
      { timestamp, type: "event_msg", payload: { type: "user_message", message, kind: "plain" } },
    ];
    const filename = `rollout-${timestamp.replace(/\.\d{3}Z$/, "").replaceAll(":", "-")}-${id}.jsonl`;
    return { filename, timestamp, records };
  });
  // Exercise real on-disk Codex histories through SSH and app-server; no model turns are started.
  const fixtureScript = `
set -eu
rollout_dir="\${CODEX_HOME:-$HOME/.codex}/sessions/2026/01/02"
mkdir -p -- "$rollout_dir" ${shellQuote(childCwd)}
${entries
  .map(
    (entry) => `cat > "$rollout_dir/${entry.filename}" <<'JSONL'
${entry.records.map((record) => JSON.stringify(record)).join("\n")}
JSONL
touch -d ${shellQuote(entry.timestamp)} "$rollout_dir/${entry.filename}"`,
  )
  .join("\n")}
`;
  await execRemoteSsh(remoteWorkspace.remote, fixtureScript);

  const list = (query: string) =>
    authenticatedFetch(page, { url: `/api/threads?hostId=${host.id}&${query}` }, (value) =>
      listResponseSchema.parse(value),
    );
  const projectQuery = `cwd=${encodeURIComponent(cwd)}&limit=50`;
  const allSources = await list(`${projectQuery}&mainThreadOnly=false`);
  expect(allSources.data).toHaveLength(50);
  expect(allSources.data.some((thread) => thread.id === mainId)).toBe(false);

  const mainPage = await list(`${projectQuery}&mainThreadOnly=true`);
  expect(mainPage.data).toHaveLength(50);
  expect(mainPage.nextCursor).toEqual(expect.any(String));
  const mainPageIds = new Set(mainPage.data.map((thread) => thread.id));
  const olderMainPage = await list(
    `${projectQuery}&mainThreadOnly=true&cursor=${encodeURIComponent(mainPage.nextCursor!)}`,
  );
  expect(olderMainPage.data).toHaveLength(5);
  expect(olderMainPage.data.some((thread) => mainPageIds.has(thread.id))).toBe(false);
  expect(olderMainPage.nextCursor).toBeNull();

  // A broad host page discovers every source in the background, including the project
  // containing only a child thread. Wait for that index before exercising the project UI,
  // whose fast path intentionally reads the remote state index.
  await list("limit=1&mainThreadOnly=true");
  await expect
    .poll(async () => (await list("limit=1&mainThreadOnly=true")).projects.map((p) => p.remotePath))
    .toContain(childCwd);

  // The project home consumes the same native cursor. The first 50 rows render immediately;
  // loading the next page appends the remaining sessions without replacing existing rows.
  const project = await remoteWorkspace.addProject(host.id, `pagination-${Date.now()}`, cwd);
  await page.getByTestId(`project-button-${project.id}`).click();
  const projectPage = page.getByTestId("project-thread-list");
  await expect(projectPage).toBeVisible();
  await expect(projectPage.getByTestId("load-more-project-threads")).toBeVisible({
    timeout: 30_000,
  });
  const firstPageRows = projectPage.locator('[data-testid^="project-thread-row-"]');
  await expect(firstPageRows).toHaveCount(50);
  await projectPage.getByTestId("load-more-project-threads").click();
  await expect(projectPage.getByTestId(`project-thread-row-${mainId}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(firstPageRows).toHaveCount(55);
  await expect(projectPage.getByTestId("load-more-project-threads")).toHaveCount(0);

  const childPage = await list(`cwd=${encodeURIComponent(childCwd)}&limit=50`);
  expect(childPage.data.map((thread) => thread.id)).toEqual([childIds[54]]);
  expect(childPage.data[0]?.parentThreadId).toBe(mainId);
});

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
