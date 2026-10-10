import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "../util/test_shim.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const { releaseIdentity, publishRelease, requestJson } = await import(
  pathToFileURL(join(workspaceRoot, "scripts/release.mjs")).href
);
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  RELEASE_SERIES: "0.41",
  GITHUB_RUN_NUMBER: "123",
  GITHUB_SHA: "a".repeat(40),
};
const identity = releaseIdentity(env);

function fixture() {
  const state = {
    ref: null as null | { object: { type: string; sha: string } },
    release: null as null | {
      id: number;
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
    },
    published: false,
    fail: "",
    calls: [] as string[],
  };
  const services = {
    github: async (path: string, options?: { method: string; body: any }) => {
      if (!options) {
        return path.startsWith("/git/") ? state.ref : state.release;
      }
      state.calls.push(path);
      if (state.fail === path) throw new Error("injected failure");
      if (path === "/git/refs") {
        assert.equal(options.body.sha, env.GITHUB_SHA);
        state.ref = { object: { type: "commit", sha: options.body.sha } };
        return state.ref;
      }
      state.release = {
        id: 1,
        tag_name: identity.tag,
        draft: options.body.draft,
        prerelease: false,
      };
      return state.release;
    },
    registry: async () => (state.published ? {} : null),
    prepare: async () => {
      state.calls.push("prepare");
      if (state.fail === "prepare") throw new Error("injected failure");
    },
    verify: async () => {
      state.calls.push("verify");
      if (state.fail === "verify") throw new Error("injected failure");
    },
    publish: async () => {
      state.calls.push("publish");
      if (state.fail === "publish") throw new Error("injected failure");
      state.published = true;
    },
    assets: async () => {
      state.calls.push("assets");
      if (state.fail === "assets") throw new Error("injected failure");
    },
  };
  return { state, services };
}

describe("Manual releases", () => {
  it("uses the increasing run number and ignores the attempt number", () => {
    assert.equal(identity.version, "0.41.123");
    assert.deepEqual(
      releaseIdentity({ ...env, GITHUB_RUN_ATTEMPT: "9" }),
      identity,
    );
    assert.equal(
      releaseIdentity({ ...env, GITHUB_RUN_NUMBER: "124" }).version,
      "0.41.124",
    );
  });

  it("rejects nonmanual, nonmain and malformed version inputs", () => {
    for (const overrides of [
      { GITHUB_EVENT_NAME: "push" },
      { GITHUB_REF: "refs/heads/feature" },
      { RELEASE_SERIES: "0.01" },
      { RELEASE_SERIES: "0.41\nattack" },
      { RELEASE_SERIES: "1.2.3" },
      { GITHUB_RUN_NUMBER: "0" },
      { GITHUB_RUN_NUMBER: "01" },
      { GITHUB_RUN_NUMBER: "9007199254740992" },
      { GITHUB_SHA: "main" },
    ]) {
      assert.throws(() => releaseIdentity({ ...env, ...overrides }));
    }
  });

  it("publishes once and makes a successful rerun a no-op", async () => {
    const { state, services } = fixture();
    assert.equal(await publishRelease(identity, services), "released");
    assert.deepEqual(state.calls, [
      "prepare",
      "verify",
      "/git/refs",
      "publish",
      "/releases",
      "assets",
      "/releases/1",
    ]);
    state.calls = [];
    assert.equal(await publishRelease(identity, services), "already released");
    assert.deepEqual(state.calls, ["assets"]);
  });

  it("resumes failures without republishing a completed registry version", async () => {
    for (const failure of [
      "prepare",
      "verify",
      "/git/refs",
      "publish",
      "/releases",
      "assets",
      "/releases/1",
    ]) {
      const { state, services } = fixture();
      state.fail = failure;
      await assert.rejects(publishRelease(identity, services), /injected/);
      if (["prepare", "verify", "/git/refs"].includes(failure)) {
        assert.equal(state.ref, null);
        assert.equal(state.published, false);
      }
      state.fail = "";
      state.calls = [];
      await publishRelease(identity, services);
      assert.ok(state.release);
      assert.ok(state.published);
      assert.equal(state.release.draft, false);
      if (["/releases", "assets", "/releases/1"].includes(failure)) {
        assert.ok(!state.calls.includes("publish"));
        assert.ok(!state.calls.includes("prepare"));
      }
    }
  });

  it("refuses a version reserved for other source or published without a tag", async () => {
    const { state, services } = fixture();
    state.ref = { object: { type: "commit", sha: "b".repeat(40) } };
    await assert.rejects(
      publishRelease(identity, services),
      /different source/,
    );
    state.ref = null;
    state.published = true;
    await assert.rejects(publishRelease(identity, services), /reservation tag/);
    assert.deepEqual(state.calls, []);
  });

  it("treats only GET 404 as absent and fails closed on API errors", async () => {
    const response = (status: number) => async () =>
      new Response("{}", { status });
    assert.equal(
      await requestJson("https://example.test", {}, response(404)),
      null,
    );
    for (const status of [401, 403, 429, 500]) {
      await assert.rejects(
        requestJson("https://example.test", {}, response(status)),
      );
    }
    await assert.rejects(
      requestJson("https://example.test", { method: "POST" }, response(404)),
    );
  });
});
