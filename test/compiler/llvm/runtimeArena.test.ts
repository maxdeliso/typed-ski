import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../../../lib/shared/workspaceRoot.ts";
import { describe, it } from "../../util/test_shim.ts";
import { compileLlvmToExecutable, runExecutable } from "./nativeHarness.ts";

describe("process-lifetime object arena", () => {
  it("preserves aligned, zeroed objects across ordinary and oversized chunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trip-arena-"));
    try {
      const path = join(dir, "arena.ll");
      await writeFile(
        path,
        "declare i32 @runtime_arena_probe()\ndefine i32 @main() {\nentry:\n  %result = call i32 @runtime_arena_probe()\n  ret i32 %result\n}\n",
      );
      const exe = await compileLlvmToExecutable(path, [
        join(workspaceRoot, "runtime/trip/trip_runtime.c"),
        join(workspaceRoot, "test/compiler/llvm/fixtures/runtime-arena.c"),
      ]);
      const result = runExecutable(exe);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const measured = spawnSync(exe, [], {
        encoding: "utf8",
        env: { ...process.env, TRIP_RUNTIME_STATS: "1" },
      });
      assert.equal(measured.status, 0, measured.stderr);
      assert.equal(measured.stdout, "");
      assert.match(
        measured.stderr,
        /^trip arena: objects=100005 object_bytes=\d+ reserved_bytes=\d+ chunks=\d+\r?\n$/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects object-size overflow before allocating or writing fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trip-arena-overflow-"));
    try {
      const path = join(dir, "overflow.ll");
      await writeFile(
        path,
        "declare ptr @trip_alloc_obj(i64, i64)\ndefine i32 @main() {\nentry:\n  %obj = call ptr @trip_alloc_obj(i64 0, i64 -1)\n  ret i32 0\n}\n",
      );
      const result = spawnSync(await compileLlvmToExecutable(path), [], {
        encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      if (result.status === null) {
        assert.equal(result.signal, "SIGABRT", result.stderr);
      } else {
        assert.notEqual(result.status, 0, result.stderr);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects null/small field pointers and out-of-bounds field reads and writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trip-arena-guards-"));
    try {
      const cases = [
        {
          body: "%value = call i64 @trip_obj_field(ptr null, i64 0)",
          error: /obj is NULL/,
        },
        {
          body: "%value = call i64 @trip_obj_field(ptr inttoptr (i64 2 to ptr), i64 0)",
          error: /obj < 256/,
        },
        {
          body: "call void @trip_obj_set_field(ptr null, i64 0, i64 1)",
          error: /Invalid pointer/,
        },
        {
          body: "call void @trip_obj_set_field(ptr inttoptr (i64 2 to ptr), i64 0, i64 1)",
          error: /Invalid pointer/,
        },
        {
          body: "%obj = call ptr @trip_alloc_obj(i64 0, i64 1)\n  %value = call i64 @trip_obj_field(ptr %obj, i64 1)",
          error: /Index 1 >= arity 1/,
        },
        {
          body: "%obj = call ptr @trip_alloc_obj(i64 0, i64 1)\n  call void @trip_obj_set_field(ptr %obj, i64 1, i64 1)",
          error: /index=1 arity=1/,
        },
      ];
      for (const [index, probe] of cases.entries()) {
        const path = join(dir, `guard-${index}.ll`);
        await writeFile(
          path,
          "declare ptr @trip_alloc_obj(i64, i64)\ndeclare i64 @trip_obj_field(ptr, i64)\ndeclare void @trip_obj_set_field(ptr, i64, i64)\ndefine i32 @main() {\nentry:\n  " +
            probe.body +
            "\n  ret i32 0\n}\n",
        );
        const result = runExecutable(await compileLlvmToExecutable(path));
        assert.notEqual(result.status, 0, result.stderr);
        assert.match(result.stderr, probe.error);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function compileIoProbe(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.ll`);
  await writeFile(
    path,
    `declare i32 @${name}()\ndefine i32 @main() {\nentry:\n  %result = call i32 @${name}()\n  ret i32 %result\n}\n`,
  );
  return compileLlvmToExecutable(path, [
    join(workspaceRoot, "runtime/trip/trip_runtime.c"),
    join(workspaceRoot, "test/compiler/llvm/fixtures/runtime-io.c"),
  ]);
}

describe("runtime bulk input and optional output buffering", () => {
  it("preserves every byte across input-buffer boundaries and flushes output on normal exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trip-runtime-io-"));
    try {
      const exe = await compileIoProbe(dir, "runtime_io_bulk_probe");
      for (const length of [0, 8192, 8193, 65539]) {
        const input = Buffer.from(
          Array.from({ length }, (_, index) => index % 256),
        );
        const result = spawnSync(exe, [], {
          input,
          env: {
            ...process.env,
            TRIP_RUNTIME_BUFFER_OUTPUT: "1",
            TRIP_RUNTIME_STATS: "0",
          },
          maxBuffer: 1024 * 1024,
          timeout: 30000,
        });
        assert.equal(result.status, 0, result.stderr.toString());
        assert.deepEqual(result.stdout, input);
        assert.equal(result.stderr.length, 0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves immediate default writes and flushes buffered prompts before input over pipes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trip-runtime-prompt-"));
    try {
      for (const name of [
        "runtime_io_prompt_probe",
        "runtime_io_bulk_prompt_probe",
        "runtime_io_explicit_flush_probe",
        "runtime_io_default_visibility_probe",
      ]) {
        const exe = await compileIoProbe(dir, name);
        const modes =
          name === "runtime_io_default_visibility_probe" ? ["0"] : ["0", "1"];
        for (const buffering of modes) {
          const result = await new Promise<{
            stdout: string;
            stderr: string;
            status: number | null;
          }>((resolve, reject) => {
            const child = spawn(exe, [], {
              env: {
                ...process.env,
                TRIP_RUNTIME_BUFFER_OUTPUT: buffering,
                TRIP_RUNTIME_STATS: "0",
              },
              stdio: "pipe",
            });
            let stdout = "";
            let stderr = "";
            let responded = false;
            const timeout = setTimeout(() => {
              child.kill();
              reject(
                new Error(
                  `${name}: prompt was not flushed before input (buffering=${buffering})`,
                ),
              );
            }, 10000);
            child.stdout.on("data", (bytes: Buffer) => {
              stdout += bytes.toString();
              if (!responded && stdout.includes("P")) {
                responded = true;
                child.stdin.end("Q");
              }
            });
            child.stderr.on("data", (bytes: Buffer) => {
              stderr += bytes.toString();
            });
            child.once("error", (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            child.once("close", (status) => {
              clearTimeout(timeout);
              resolve({ stdout, stderr, status });
            });
          });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout, "PQ");
          assert.equal(result.stderr, "");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
