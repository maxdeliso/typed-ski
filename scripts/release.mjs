import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseAssets, uploadReleaseAssets } from "./release_assets.mjs";

export function runReleaseCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

export function releaseIdentity(env) {
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error("Releases require a manual workflow run on main");
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(env.RELEASE_SERIES ?? "")) {
    throw new Error("Release series must be MAJOR.MINOR");
  }
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER ?? "")) {
    throw new Error("A positive GitHub workflow run number is required");
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw new Error("A GitHub source commit SHA is required");
  }
  const version = `${env.RELEASE_SERIES}.${env.GITHUB_RUN_NUMBER}`;
  if (version.split(".").some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error("Version components must be safe integers");
  }
  return { version, tag: `v${version}`, sha: env.GITHUB_SHA };
}

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  if (
    response.status === 404 &&
    (!options.method || options.method === "GET")
  ) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Release request failed: ${response.status} ${url}`);
  }
  return response.json();
}

export async function publishRelease(identity, services) {
  const { version, tag, sha } = identity;
  const { github, registry, prepare, verify, publish, assets } = services;
  const tagPath = `/git/ref/tags/${tag}`;
  const releasePath = `/releases/tags/${tag}`;
  let ref = await github(tagPath);
  if (ref && (ref.object.type !== "commit" || ref.object.sha !== sha)) {
    throw new Error(`${tag} already belongs to a different source commit`);
  }
  let release = await github(releasePath);
  const published = await registry(version);
  if ((published || release) && !ref) {
    throw new Error(`${version} exists without its source reservation tag`);
  }
  if (release?.prerelease) {
    throw new Error(`${tag} has an unexpected prerelease`);
  }
  if (release && !release.draft && published) {
    await assets(release);
    return "already released";
  }
  if (!published) {
    await prepare(version);
    await verify();
    if (!ref) {
      ref = await github("/git/refs", {
        method: "POST",
        body: { ref: `refs/tags/${tag}`, sha },
      });
      if (ref.object.type !== "commit" || ref.object.sha !== sha) {
        throw new Error(`Could not reserve ${tag} for the source commit`);
      }
    }
    await publish();
  }
  if (!release) {
    release = await github("/releases", {
      method: "POST",
      body: {
        tag_name: tag,
        target_commitish: sha,
        name: tag,
        body: `Published ${version} from ${sha}.`,
        generate_release_notes: true,
        draft: true,
      },
    });
  }
  await assets(release);
  if (release.draft) {
    await github(`/releases/${release.id}`, {
      method: "PATCH",
      body: { draft: false, make_latest: "legacy" },
    });
  }
  return "released";
}

async function main() {
  const identity = releaseIdentity(process.env);
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !token) {
    throw new Error("GitHub repository and token are required");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (head !== identity.sha)
    throw new Error("Checkout differs from workflow SHA");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^@[\w-]+\/[\w-]+$/.test(pkg.name))
    throw new Error("Invalid package name");
  const run = (command, args) =>
    runReleaseCommand(command, args, { cwd: root });
  const files = releaseAssets(join(root, "release-assets"), identity.version);
  const result = await publishRelease(identity, {
    github: (path, options = {}) =>
      requestJson(`https://api.github.com/repos/${repository}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }),
    registry: (version) =>
      requestJson(`https://jsr.io/${pkg.name}/${version}_meta.json`, {
        headers: { Accept: "application/json" },
      }),
    prepare: (version) =>
      run(process.execPath, ["scripts/release_prepare.js", version]),
    verify: () =>
      run("pnpm", ["exec", "jsr", "publish", "--dry-run", "--allow-dirty"]),
    publish: () => run("pnpm", ["exec", "jsr", "publish", "--allow-dirty"]),
    assets: (release) => uploadReleaseAssets(repository, release, files),
  });
  const summary = `${identity.tag}: ${result}\n`;
  console.log(summary.trim());
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
