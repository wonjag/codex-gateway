import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CodexRemotePlatform } from "./codex-platform";
import { z } from "zod";

const ARTIFACT_IDLE_TTL_MS = 30_000;
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const RELEASE_ASSET_TIMEOUT_MS = 10 * 60_000;
const GITHUB_ASSET_API_URL =
  /^https:\/\/api\.github\.com\/repos\/openai\/codex\/releases\/assets\/\d+$/;

export interface CodexArtifactBundle {
  releaseTarget: CodexRemotePlatform["releaseTarget"];
  standaloneArchive: {
    localPath: string;
    fileName: string;
    size: number;
    sha256: string;
  };
}

interface SharedBundle {
  promise: Promise<PreparedBundle>;
  users: number;
  cleanupTimer: NodeJS.Timeout | null;
}

interface PreparedBundle {
  directory: string;
  artifacts: CodexArtifactBundle;
}

export class CodexArtifactProvider {
  private readonly shared = new Map<string, SharedBundle>();

  async acquire(version: string, platform: CodexRemotePlatform) {
    const key = `${version}:${platform.releaseTarget}`;
    let entry = this.shared.get(key);
    if (entry === undefined) {
      const promise = prepareBundle(version, platform).catch((error) => {
        this.shared.delete(key);
        throw error;
      });
      entry = { promise, users: 0, cleanupTimer: null };
      this.shared.set(key, entry);
    }
    if (entry.cleanupTimer !== null) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = null;
    }
    entry.users += 1;
    try {
      const prepared = await entry.promise;
      return {
        artifacts: prepared.artifacts,
        release: () => {
          entry.users -= 1;
          if (entry.users === 0) this.scheduleCleanup(key, entry);
        },
      };
    } catch (error) {
      entry.users -= 1;
      if (entry.users === 0) this.scheduleCleanup(key, entry);
      throw error;
    }
  }

  private scheduleCleanup(key: string, entry: SharedBundle) {
    entry.cleanupTimer = setTimeout(() => {
      if (entry.users !== 0 || this.shared.get(key) !== entry) return;
      this.shared.delete(key);
      void entry.promise.then(({ directory }) =>
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      );
    }, ARTIFACT_IDLE_TTL_MS);
    entry.cleanupTimer.unref();
  }
}

async function prepareBundle(
  version: string,
  platform: CodexRemotePlatform,
): Promise<PreparedBundle> {
  const directory = await mkdtemp(join(tmpdir(), "codex-gateway-artifacts-"));
  try {
    const release = await resolveStandaloneRelease(version, platform);
    const archivePath = join(directory, release.assetName);
    if (!(await copyVerifiedCachedArchive(version, release, archivePath))) {
      await downloadVerifiedArchive(release, archivePath);
    }
    const file = await stat(archivePath);
    return {
      directory,
      artifacts: {
        releaseTarget: platform.releaseTarget,
        standaloneArchive: {
          localPath: archivePath,
          fileName: release.assetName,
          size: file.size,
          sha256: release.sha256,
        },
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

interface StandaloneRelease {
  assetName: string;
  downloadUrls: string[];
  sha256: string;
}

async function copyVerifiedCachedArchive(
  version: string,
  release: StandaloneRelease,
  outputPath: string,
) {
  const cacheDirectory = process.env.CODEX_GATEWAY_ARTIFACT_CACHE_DIR;
  if (cacheDirectory === undefined || cacheDirectory === "") return false;
  if (!isAbsolute(cacheDirectory)) {
    throw new Error("CODEX_GATEWAY_ARTIFACT_CACHE_DIR must be an absolute directory");
  }
  const cachedPath = join(cacheDirectory, version, release.assetName);
  try {
    if (!(await lstat(cachedPath)).isFile()) {
      throw new Error(`Cached Codex archive ${release.assetName} is not a regular file`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  await copyFile(cachedPath, outputPath);
  // Verify the private snapshot that will be uploaded, not a potentially changing cache file.
  const actual = await hashFile(outputPath, "sha256");
  if (actual !== release.sha256) {
    throw new Error(
      `Cached Codex archive ${release.assetName} failed SHA-256 verification: expected ${release.sha256}, received ${actual}`,
    );
  }
  return true;
}

interface ReleaseAsset {
  name: string;
  digest: string;
  url: string;
  apiUrl?: string;
}

const releaseAssetSchema = z
  .object({
    name: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
    browser_download_url: z.url(),
    url: z.url().optional(),
  })
  .transform(({ name, digest, browser_download_url, url }) => ({
    name,
    digest,
    url: browser_download_url,
    apiUrl: url !== undefined && GITHUB_ASSET_API_URL.test(url) ? url : undefined,
  }));

const releaseMetadataSchema = z.object({
  assets: z.array(releaseAssetSchema),
});

async function resolveStandaloneRelease(
  version: string,
  platform: CodexRemotePlatform,
): Promise<StandaloneRelease> {
  const assetName = `codex-package-${platform.releaseTarget}.tar.gz`;
  const releasesUrl = `https://releases.openai.com/codex/releases/${version}/release.json`;
  const githubUrl = `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`;
  const metadataUrls = [releasesUrl, githubUrl];
  const assets: ReleaseAsset[] = [];
  const failures: string[] = [];

  for (const metadataUrl of metadataUrls) {
    try {
      assets.push(...(await readReleaseAssets(metadataUrl)));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const candidates = assets.filter((asset) => asset.name === assetName);
  if (candidates.length === 0) {
    throw new Error(
      [
        `Codex ${version} does not publish ${assetName}`,
        failures.length > 0 ? `Release metadata failures: ${failures.join("; ")}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  const sha256 = candidates[0]!.digest.slice("sha256:".length).toLowerCase();
  // releases.openai.com is preferred because the official installer uses it first. The GitHub
  // asset remains a verification-preserving fallback for temporarily unavailable infrastructure.
  return {
    assetName,
    downloadUrls: [
      ...new Set(
        candidates.flatMap(({ url, apiUrl }) => (apiUrl === undefined ? [url] : [apiUrl, url])),
      ),
    ],
    sha256,
  };
}

async function readReleaseAssets(url: string) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(RELEASE_METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return releaseMetadataSchema.parse(await response.json()).assets;
}

async function downloadVerifiedArchive(release: StandaloneRelease, outputPath: string) {
  const failures: string[] = [];
  for (const url of release.downloadUrls) {
    try {
      const isGithubApi = GITHUB_ASSET_API_URL.test(url);
      const downloadUrl = new URL(url);
      if (isGithubApi) {
        // Avoid cached redirects whose signed release-assets URL has already expired.
        downloadUrl.searchParams.set("download", "1");
        downloadUrl.searchParams.set("nonce", String(Date.now()));
      }
      const response = await fetch(downloadUrl, {
        headers: isGithubApi ? { accept: "application/octet-stream" } : undefined,
        signal: AbortSignal.timeout(RELEASE_ASSET_TIMEOUT_MS),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(Readable.from(response.body), createWriteStream(outputPath));
      const actual = await hashFile(outputPath, "sha256");
      if (actual !== release.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${release.sha256}, received ${actual}`);
      }
      return;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      await rm(outputPath, { force: true });
    }
  }
  throw new Error(
    `Failed to download official Codex archive ${release.assetName}: ${failures.join("; ")}`,
  );
}

async function hashFile(path: string, algorithm: "sha256" | "sha512") {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
