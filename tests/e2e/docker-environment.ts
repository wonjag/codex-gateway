import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "ssh2";
import { quote } from "shell-quote";
import { SUPPORTED_CODEX_VERSION } from "../../server/utils/gateway/infra/codex/codex-version";
import { connectTestSsh, execTestSsh } from "./helpers/ssh-client";
import { nodeErrorCode } from "./helpers/node-errors";
import { firstNonEmptyString } from "../../shared/utils/strings";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeDir = join(rootDir, ".e2e-runtime", "ssh-container");
const envFile = join(runtimeDir, "env.json");
const upgradeEnvFile = join(runtimeDir, "upgrade-env.json");
const mfaEnvFile = join(runtimeDir, "mfa-env.json");
const standaloneCodexBin = "/home/codex/.local/bin/codex";

type RuntimeFixture = "empty-runtime" | "legacy-node" | "npm-codex" | "current-codex";

interface RemoteEnv {
  host: string;
  port: string;
  username: string;
  password: string;
  projectPath: string;
  imagePath: string;
  runtimeFixture: RuntimeFixture;
  initialNodeVersion: string | null;
  initialCodexVersion: string | null;
  initialCodexBin: string | null;
  supportedCodexVersion: string;
  testModel: string;
  codexBin: string;
  proxyUrl: null;
  mfaCode?: string;
}

export async function startDockerEnvironment() {
  await mkdir(runtimeDir, { recursive: true });
  const password = firstNonEmptyString([process.env.E2E_REMOTE_PASSWORD]) ?? "codex";
  const shared = {
    port: firstNonEmptyString([process.env.E2E_REMOTE_PORT]) ?? "22",
    username: firstNonEmptyString([process.env.E2E_REMOTE_USERNAME]) ?? "codex",
    password,
    projectPath:
      firstNonEmptyString([process.env.E2E_REMOTE_PROJECT_PATH]) ?? "/workspace/codex-gateway",
    imagePath: "/home/codex/e2e-image.png",
    supportedCodexVersion: SUPPORTED_CODEX_VERSION,
    testModel: firstNonEmptyString([process.env.E2E_CODEX_MODEL]) ?? "gpt-6-luna",
    proxyUrl: null,
  };
  const environments: RemoteEnv[] = [
    {
      ...shared,
      host: firstNonEmptyString([process.env.E2E_REMOTE_HOST]) ?? "ssh-target",
      runtimeFixture: "empty-runtime",
      initialNodeVersion: null,
      initialCodexVersion: null,
      initialCodexBin: standaloneCodexBin,
      codexBin: standaloneCodexBin,
    },
    {
      ...shared,
      host:
        firstNonEmptyString([process.env.E2E_LEGACY_NODE_REMOTE_HOST]) ?? "ssh-target-legacy-node",
      runtimeFixture: "legacy-node",
      initialNodeVersion: "14.21.3",
      initialCodexVersion: null,
      initialCodexBin: standaloneCodexBin,
      codexBin: standaloneCodexBin,
    },
    {
      ...shared,
      host: firstNonEmptyString([process.env.E2E_NPM_CODEX_REMOTE_HOST]) ?? "ssh-target-npm-codex",
      runtimeFixture: "npm-codex",
      initialNodeVersion: "22.23.1",
      initialCodexVersion: firstNonEmptyString([process.env.E2E_CODEX_CLI_VERSION]) ?? "0.140.0",
      initialCodexBin: "/home/codex/.nvm/versions/node/v22.23.1/bin/codex",
      codexBin: standaloneCodexBin,
    },
  ];
  const mfaEnvironment: RemoteEnv = {
    ...shared,
    host: firstNonEmptyString([process.env.E2E_MFA_REMOTE_HOST]) ?? "ssh-target-mfa",
    runtimeFixture: "current-codex",
    initialNodeVersion: null,
    initialCodexVersion: SUPPORTED_CODEX_VERSION,
    initialCodexBin: standaloneCodexBin,
    codexBin: standaloneCodexBin,
    mfaCode: "123456",
  };

  await Promise.all(
    [...environments, mfaEnvironment].map(async (env) => {
      try {
        await waitForSsh(env.host, env.port);
      } catch (error: unknown) {
        throw new Error(`SSH readiness failed for ${env.host}:${env.port}`, { cause: error });
      }
    }),
  );
  for (const env of [...environments, mfaEnvironment]) {
    try {
      await prepareRemoteCodexHome(env);
    } catch (error: unknown) {
      throw new Error(`SSH fixture preparation failed for ${env.host}:${env.port}`, {
        cause: error,
      });
    }
  }
  await writeRemoteImage(environments[0]!);
  await Promise.all([
    writeFile(envFile, JSON.stringify(environments[0], null, 2)),
    writeFile(upgradeEnvFile, JSON.stringify(environments, null, 2)),
    writeFile(mfaEnvFile, JSON.stringify(mfaEnvironment, null, 2)),
  ]);
  return environments[0];
}

export async function stopDockerEnvironment() {
  await rm(runtimeDir, { recursive: true, force: true });
}

async function waitForSsh(host: string, port: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await waitForPort(host, Number(port), 2_000);
      return;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for SSH target: ${lastError}`);
}

function waitForPort(host: string, port: number, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    socket.connect(port, host);
  });
}

async function prepareRemoteCodexHome(env: RemoteEnv) {
  const sourceCodexHome =
    firstNonEmptyString([process.env.E2E_CODEX_HOME, process.env.CODEX_HOME]) ??
    join(homedir(), ".codex");
  const codexHome = join(runtimeDir, "codex-home");
  await prepareCodexHome(sourceCodexHome, codexHome);

  const connection = await connectTestSsh({ ...env, keyboardInteractiveCode: env.mfaCode });
  try {
    if (process.env.E2E_PREPARE_REMOTE_PROJECT_DIR === "1") {
      if (!env.projectPath.startsWith("/")) {
        throw new Error("The prepared remote project directory must be an absolute path");
      }
      const projectPath = quote([env.projectPath]);
      // Create the NAS topology's scratch cwd as the actual SSH user, without changing ownership
      // or permissions of the source checkout. File/Git tests create their own separate fixtures.
      await execTestSsh(
        connection,
        `mkdir -p -- ${projectPath} && test -r ${projectPath} && test -w ${projectPath} && test -x ${projectPath}`,
      );
    }
    await execTestSsh(connection, "rm -rf /home/codex/.codex && mkdir -p /home/codex/.codex");
    await uploadDirectory(connection, codexHome, "/home/codex/.codex");
    if (env.runtimeFixture === "current-codex") {
      // Codex auth/config is uploaded into CODEX_HOME, so restore the standalone fixture after:
      // the actual package intentionally lives beside those files in the official layout.
      await execTestSsh(
        connection,
        `
set -eu
codex_home=/home/codex/.codex
release_dir="$codex_home/packages/standalone/releases/e2e"
mkdir -p "$release_dir" /home/codex/.local/bin
cp -a /opt/codex-standalone/. "$release_dir/"
ln -sfn "$release_dir" "$codex_home/packages/standalone/current"
ln -sfn "$codex_home/packages/standalone/current/bin/codex" /home/codex/.local/bin/codex
`,
      );
    }
  } finally {
    connection.end();
  }
}

async function writeRemoteImage(env: RemoteEnv) {
  const connection = await connectTestSsh(env);
  try {
    await execTestSsh(
      connection,
      `printf %s iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg== | base64 -d > ${env.imagePath}`,
    );
  } finally {
    connection.end();
  }
}

export async function execRemoteSsh(env: RemoteEnv, command: string) {
  const connection = await connectTestSsh(env);
  try {
    return await execTestSsh(connection, command);
  } finally {
    connection.end();
  }
}

async function uploadDirectory(
  connection: Client,
  localDirectory: string,
  remoteDirectory: string,
) {
  const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
    connection.sftp((error, client) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(client);
    });
  });
  try {
    await mkdirRemote(sftp, remoteDirectory);
    await uploadDirectoryEntries(sftp, localDirectory, remoteDirectory);
  } finally {
    sftp.end();
  }
}

async function uploadDirectoryEntries(
  sftp: import("ssh2").SFTPWrapper,
  localDirectory: string,
  remoteDirectory: string,
) {
  const entries = await readdir(localDirectory);
  for (const entry of entries) {
    const localPath = join(localDirectory, entry);
    const remotePath = `${remoteDirectory}/${basename(entry)}`;
    const stats = await stat(localPath);
    if (stats.isDirectory()) {
      await mkdirRemote(sftp, remotePath);
      await uploadDirectoryEntries(sftp, localPath, remotePath);
    } else if (stats.isFile()) {
      await uploadFile(sftp, localPath, remotePath);
    }
  }
}

async function mkdirRemote(sftp: import("ssh2").SFTPWrapper, path: string) {
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, (error) => {
      if (error === undefined || error === null || nodeErrorCode(error) === 4) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function uploadFile(sftp: import("ssh2").SFTPWrapper, localPath: string, remotePath: string) {
  const data = await readFile(localPath);
  await new Promise<void>((resolve, reject) => {
    sftp.writeFile(remotePath, data, { mode: 0o600 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export { envFile, mfaEnvFile, upgradeEnvFile };

async function prepareCodexHome(sourceCodexHome: string, codexHome: string) {
  await rm(codexHome, { recursive: true, force: true });
  await mkdir(codexHome, { recursive: true });
  await Promise.all([
    copyOptional(join(sourceCodexHome, "auth.json"), join(codexHome, "auth.json")),
    copyOptional(join(sourceCodexHome, "config.toml"), join(codexHome, "config.toml")),
    copyOptional(join(sourceCodexHome, "version.json"), join(codexHome, "version.json")),
    // config.toml may reference CODEX_HOME-relative catalogs. Copy them with the config so the
    // real app-server does not fall back to invalid defaults inside the isolated SSH fixtures.
    copyOptionalDirectory(
      join(sourceCodexHome, "model-catalogs"),
      join(codexHome, "model-catalogs"),
    ),
  ]);
}

async function copyOptional(source: string, target: string) {
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function copyOptionalDirectory(source: string, target: string) {
  try {
    await cp(source, target, { recursive: true });
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}
