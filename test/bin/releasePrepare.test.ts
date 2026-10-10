import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "../util/test_shim.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import {
  createTempWorkspace,
  cleanupTempWorkspace,
} from "../util/tripcHarness.ts";

const helper = pathToFileURL(
  join(workspaceRoot, "scripts/release_helpers.mjs"),
).href;
const generator = join(workspaceRoot, "scripts/generate_version.mjs");
const files = ["tripc.js", "tripc.min.js", "tripc.node.js"];

function runNode(args: string[], env = process.env) {
  return spawnSync(process.execPath, args, { encoding: "utf8", env });
}

async function fixture(version = "1.2.3") {
  const root = await createTempWorkspace("typed-ski-release-");
  const bazelBin = join(root, "output");
  await Promise.all([
    mkdir(join(root, "lib/shared"), { recursive: true }),
    mkdir(join(root, "dist"), { recursive: true }),
    mkdir(join(bazelBin, "lib/shared"), { recursive: true }),
    mkdir(join(bazelBin, "dist_artifacts"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "@maxdeliso/typed-ski",
        version: "0.0.0-dev",
        type: "module",
        license: "MIT",
        exports: { ".": "./lib/index.ts" },
        files: ["lib/**", "dist/**"],
        devDependencies: { "build-only": "1.0.0" },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(root, "lib/index.ts"), "export const example = 1;\n");
  await writeFile(join(root, "jsr.json"), '{"previous":true}\n');
  await writeFile(
    join(root, "lib/shared/version.generated.ts"),
    "previous generated version\n",
  );
  await writeFile(join(root, "dist/stale.txt"), "previous distribution\n");
  for (const file of files) {
    await writeFile(
      join(bazelBin, "dist_artifacts", file),
      `console.log(${JSON.stringify(`tripc v${version}`)});\n`,
    );
  }
  for (const file of ["tripc", "tripc.cmd"]) {
    await writeFile(join(bazelBin, "dist_artifacts", file), "built launcher\n");
  }
  const generated = runNode(
    [
      generator,
      "--package-json",
      join(root, "package.json"),
      "--ts-out",
      join(bazelBin, "lib/shared/version.generated.ts"),
      "--jsr-json",
      join(bazelBin, "jsr.json"),
    ],
    { ...process.env, RELEASE_VERSION: version },
  );
  assert.equal(generated.status, 0, generated.stderr);
  return { root, bazelBin };
}

async function currentMetadata(root: string) {
  return Promise.all(
    [
      "package.json",
      "jsr.json",
      "lib/shared/version.generated.ts",
      "dist/stale.txt",
    ].map((path) => readFile(join(root, path), "utf8")),
  );
}

function prepare(
  root: string,
  bazelBin: string,
  options: object = {},
  buildFailure = false,
) {
  return runNode([
    "--input-type=module",
    "--eval",
    `
    import { prepareRelease } from ${JSON.stringify(helper)};
    prepareRelease({root:${JSON.stringify(root)}, bazelBin:${JSON.stringify(bazelBin)},
      version:"1.2.3", ...${JSON.stringify(options)},
      build:() => { ${buildFailure ? 'throw new Error("simulated build failure");' : ""} }
    });
  `,
  ]);
}

describe("Release preparation", () => {
  it("executes the version generator through preserved directory symlinks", async () => {
    const { root, bazelBin } = await fixture();
    try {
      const source = join(root, "generator-source");
      const link = join(root, "generator-link");
      await mkdir(source);
      await writeFile(
        join(source, "generate_version.mjs"),
        await readFile(generator),
      );
      await symlink(
        source,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      const output = join(bazelBin, "linked-version.ts");
      const result = runNode(
        [
          join(link, "generate_version.mjs"),
          "--package-json",
          join(root, "package.json"),
          "--ts-out",
          output,
        ],
        {
          ...process.env,
          NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main",
          RELEASE_VERSION: "3.2.1",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(await readFile(output, "utf8"), /VERSION = "3\.2\.1"/);
    } finally {
      await cleanupTempWorkspace(root);
    }
  });

  it("replaces stale outputs with the complete package and both portable launchers", async () => {
    for (const platform of ["linux", "win32"]) {
      const { root, bazelBin } = await fixture();
      try {
        const result = prepare(root, bazelBin, { platform });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          (await readdir(join(root, "dist"))).sort(),
          [...files, "tripc", "tripc.cmd"].sort(),
        );
        assert.equal(
          JSON.parse(await readFile(join(root, "package.json"), "utf8"))
            .version,
          "1.2.3",
        );
        const manifest = JSON.parse(
          await readFile(join(root, "jsr.json"), "utf8"),
        );
        assert.equal(manifest.version, "1.2.3");
        assert.deepEqual(manifest.exports, { ".": "./lib/index.ts" });
        assert.deepEqual(manifest.imports, {});
        assert.match(
          await readFile(join(root, "dist/tripc.cmd"), "utf8"),
          /node "%~dp0tripc\.node\.js" %\*/,
        );
        assert.match(
          await readFile(join(root, "dist/tripc"), "utf8"),
          /exec node "\$DIR\/tripc\.node\.js" "\$@"/,
        );
        assert.ok(
          !(await readdir(root)).some((path) =>
            path.startsWith(".release-prepare-"),
          ),
        );
      } finally {
        await cleanupTempWorkspace(root);
      }
    }
  });

  it("rejects invalid SemVer before changing metadata or starting a build", async () => {
    const { root, bazelBin } = await fixture();
    try {
      const before = await currentMetadata(root);
      for (const version of ["1.2", "01.2.3", "1.2.3-01", '1.2.3";bad']) {
        const result = prepare(root, bazelBin, { version }, true);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /valid SemVer/);
        assert.deepEqual(await currentMetadata(root), before);
      }
    } finally {
      await cleanupTempWorkspace(root);
    }
  });

  it("restores original metadata and distribution after a build failure", async () => {
    const { root, bazelBin } = await fixture();
    try {
      const before = await currentMetadata(root);
      const result = prepare(root, bazelBin, {}, true);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /simulated build failure/);
      assert.deepEqual(await currentMetadata(root), before);
    } finally {
      await cleanupTempWorkspace(root);
    }
  });

  it("rejects missing or empty built artifacts instead of keeping stale files", async () => {
    const cases = [
      ...files,
      process.platform === "win32" ? "tripc.cmd" : "tripc",
    ].map((file) => ({ file, empty: false }));
    cases.push({ file: "tripc.js", empty: true });
    for (const { file, empty } of cases) {
      const { root, bazelBin } = await fixture();
      try {
        const before = await currentMetadata(root);
        if (empty) await writeFile(join(bazelBin, "dist_artifacts", file), "");
        else await rm(join(bazelBin, "dist_artifacts", file));
        const result = prepare(root, bazelBin);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Missing or empty release artifact/);
        assert.deepEqual(await currentMetadata(root), before);
      } finally {
        await cleanupTempWorkspace(root);
      }
    }
  });

  it("rejects stale generated metadata and stale embedded CLI versions", async () => {
    for (const stale of ["jsr", "version", "tripc.min.js"]) {
      const { root, bazelBin } = await fixture();
      try {
        const before = await currentMetadata(root);
        if (stale === "jsr") {
          const path = join(bazelBin, "jsr.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.version = "1.2.2";
          await writeFile(path, JSON.stringify(manifest));
        } else if (stale === "version") {
          await writeFile(
            join(bazelBin, "lib/shared/version.generated.ts"),
            'export const VERSION = "1.2.2";\n',
          );
        } else {
          await writeFile(
            join(bazelBin, "dist_artifacts", stale),
            'console.log("tripc v1.2.2");\n',
          );
        }
        const result = prepare(root, bazelBin);
        assert.notEqual(result.status, 0);
        assert.match(
          result.stderr,
          /Generated JSR metadata|version constant is stale|embeds a stale release version/,
        );
        assert.deepEqual(await currentMetadata(root), before);
      } finally {
        await cleanupTempWorkspace(root);
      }
    }
  });

  it("checks the declared source exports before building", async () => {
    const { root, bazelBin } = await fixture();
    try {
      await rm(join(root, "lib/index.ts"));
      const before = await currentMetadata(root);
      const result = prepare(root, bazelBin, {}, true);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Missing or empty release artifact/);
      assert.deepEqual(await currentMetadata(root), before);
    } finally {
      await cleanupTempWorkspace(root);
    }
  });

  it("rejects missing transitive imports from public source entrypoints", async () => {
    const { root, bazelBin } = await fixture();
    try {
      await writeFile(
        join(root, "lib/index.ts"),
        'export { missing } from "./missing.ts";\n',
      );
      const before = await currentMetadata(root);
      const result = prepare(root, bazelBin);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Could not resolve.*missing\.ts/);
      assert.deepEqual(await currentMetadata(root), before);
    } finally {
      await cleanupTempWorkspace(root);
    }
  });

  it("stages a dry-run package without changing its development version", async () => {
    const { root, bazelBin } = await fixture("0.0.0-dev");
    try {
      const packageBefore = await readFile(join(root, "package.json"), "utf8");
      const result = prepare(
        root,
        bazelBin,
        { version: "0.0.0-dev", stageOnly: true },
        true,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        await readFile(join(root, "package.json"), "utf8"),
        packageBefore,
      );
    } finally {
      await cleanupTempWorkspace(root);
    }
  });

  it("uses the release override consistently in TS, JS, and JSR metadata", async () => {
    const { root, bazelBin } = await fixture();
    try {
      const generatedJs = join(bazelBin, "version.generated.js");
      const result = runNode(
        [
          generator,
          "--package-json",
          join(root, "package.json"),
          "--ts-out",
          join(bazelBin, "lib/shared/version.generated.ts"),
          "--js-out",
          generatedJs,
          "--jsr-json",
          join(bazelBin, "jsr.json"),
        ],
        { ...process.env, RELEASE_VERSION: "9.8.7" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(await readFile(generatedJs, "utf8"), /VERSION = "9\.8\.7"/);
      assert.equal(
        JSON.parse(await readFile(join(bazelBin, "jsr.json"), "utf8")).version,
        "9.8.7",
      );
      assert.equal(
        await readFile(generatedJs, "utf8"),
        await readFile(
          join(bazelBin, "lib/shared/version.generated.ts"),
          "utf8",
        ),
      );
    } finally {
      await cleanupTempWorkspace(root);
    }
  });
});
