import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const [sourceArgument, snapshotArgument] = process.argv.slice(2);
if (sourceArgument === undefined || snapshotArgument === undefined) {
  throw new Error("Usage: dependency-workspace.ts /completed/workspace /new/workspace");
}
const source = realpathSync(sourceArgument);
const snapshot = realpathSync(snapshotArgument);
if (source !== resolve(sourceArgument) || snapshot !== resolve(snapshotArgument)) {
  throw new Error("Dependency workspace bind sources must not contain symbolic links");
}

function requireMatchingFile(relativePath: string) {
  if (
    !readFileSync(join(source, relativePath)).equals(readFileSync(join(snapshot, relativePath)))
  ) {
    throw new Error(`Dependency workspace differs from the current source: ${relativePath}`);
  }
}

function packageDirectories(directory: string) {
  return readdirSync(join(directory, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((relativePath) => statSync(join(directory, relativePath, "package.json")).isFile())
    .sort();
}

for (const manifest of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  requireMatchingFile(manifest);
}
const packages = packageDirectories(snapshot);
if (JSON.stringify(packages) !== JSON.stringify(packageDirectories(source))) {
  throw new Error("Dependency workspace package set differs from the current source");
}
for (const packageDirectory of packages) {
  requireMatchingFile(`${packageDirectory}/package.json`);
}

// This repository pins pnpm 12, which writes JSON in .modules.yaml. Validate its installed
// layout before exposing the cache to another container; never reinterpret a different format.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(path: string) {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Expected an object in ${path}`);
  return value;
}

const metadata = readRecord(join(source, "node_modules/.modules.yaml"));
const manifest = readRecord(join(snapshot, "package.json"));
if (
  typeof manifest.packageManager !== "string" ||
  metadata.packageManager !== manifest.packageManager.split("+")[0] ||
  metadata.nodeLinker !== "isolated" ||
  metadata.virtualStoreDir !== ".pnpm" ||
  metadata.storeDir !== "/cache/pnpm-store/v11" ||
  !isRecord(metadata.included) ||
  metadata.included.dependencies !== true ||
  metadata.included.devDependencies !== true ||
  !Array.isArray(metadata.pendingBuilds) ||
  metadata.pendingBuilds.length !== 0 ||
  !statSync(join(source, "node_modules/.pnpm")).isDirectory()
) {
  throw new Error("Dependency workspace has an incompatible or incomplete pnpm installation");
}

const volumes = ["", ...packages].map((relativePath) => {
  const directory = join(source, relativePath, "node_modules");
  if (!statSync(directory).isDirectory() || realpathSync(directory) !== directory) {
    throw new Error(`Dependency workspace is missing a regular dependency directory: ${directory}`);
  }
  return {
    type: "bind",
    source: directory,
    target: join("/workspace/codex-gateway", relativePath, "node_modules"),
  };
});
process.stdout.write(
  JSON.stringify({ services: { "build-runner": { volumes }, "test-runner": { volumes } } }),
);
