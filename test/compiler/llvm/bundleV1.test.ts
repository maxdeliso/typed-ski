import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "../../util/test_shim.ts";
import {
  compileTripBundleV1ToLlvm,
  parseTripBundleV1,
  parseTripBundleV1String,
  serializeTripBundleV1,
  serializeTripBundleV1ToString,
  summarizeTripBundleV1,
  TripBundleV1Error,
  type TripBundleV1,
} from "../../../lib/compiler/index.ts";
import { NativeV1SubsetError } from "../../../lib/minicore/index.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function moduleRecord(name: string, source: string): string {
  return `module ${name} ${source.length}\n${source}`;
}

function bundleSource(fields: {
  entry?: string;
  target?: string;
  wrapper?: string;
  modules: Array<{ name: string; source: string }>;
}): string {
  return [
    "TRIP-BUNDLE-V1",
    `entry ${fields.entry ?? "Main"}`,
    `target ${fields.target ?? "x86_64-unknown-linux-gnu"}`,
    `wrapper ${fields.wrapper ?? "c-main"}`,
    `modules ${fields.modules.length}`,
    ...fields.modules.map((module) => moduleRecord(module.name, module.source)),
  ].join("\n");
}

describe("bundle-v1", () => {
  const bundle: TripBundleV1 = {
    entryModule: "Main",
    target: { kind: "x86_64-unknown-linux-gnu" },
    mainWrapper: { kind: "c-main" },
    modules: [
      {
        name: "Main",
        source: `module Main
export main
poly main = #u8(7)
`,
      },
    ],
  };

  it("round-trips a deterministic source bundle", () => {
    const serialized = serializeTripBundleV1(bundle);
    assert.deepEqual(
      serializeTripBundleV1(parseTripBundleV1(serialized)),
      serialized,
    );
    assert.equal(serializeTripBundleV1ToString(bundle), decode(serialized));
    assert.deepEqual(
      parseTripBundleV1String(decode(serialized)),
      parseTripBundleV1(serialized),
    );
  });

  it("serializes byte-exact canonical records", () => {
    assert.equal(
      decode(serializeTripBundleV1(bundle)),
      [
        "TRIP-BUNDLE-V1",
        "entry Main",
        "target x86_64-unknown-linux-gnu",
        "wrapper c-main",
        "modules 1",
        "module Main 43",
        `module Main
export main
poly main = #u8(7)
`,
      ].join("\n"),
    );
  });

  it("summarizes the bootstrap-facing canonical bundle fixture", () => {
    const bundleBytes = readFileSync(
      join(fixtureDir, "bootstrap-summary.bundle-v1"),
    );
    const expectedSummary = readFileSync(
      join(fixtureDir, "bootstrap-summary.txt"),
      "utf8",
    ).replace(/\n$/, "");

    assert.equal(summarizeTripBundleV1(bundleBytes), expectedSummary);
    assert.equal(
      Buffer.compare(
        Buffer.from(serializeTripBundleV1(parseTripBundleV1(bundleBytes))),
        bundleBytes,
      ),
      0,
    );
    assert.deepEqual(
      parseTripBundleV1(bundleBytes).modules.map((module) => module.name),
      ["Lib", "Main"],
    );
  });

  it(
    "future Trip-side parser summary executable matches the golden fixture",
    { skip: true },
    () => {
      // Native-v1 stage1 should eventually compile a Trip program with the
      // stdin-list-u8 wrapper that reads bootstrap-summary.bundle-v1 from stdin
      // and writes bootstrap-summary.txt exactly.
    },
  );

  it("compiles a bundle to LLVM IR", () => {
    const llvm = compileTripBundleV1ToLlvm(serializeTripBundleV1(bundle));
    assert.match(llvm, /target triple = "x86_64-unknown-linux-gnu"/);
    assert.match(llvm, /define i8 @trip_fn_Main_main\(\)/);
    assert.match(llvm, /define i32 @main\(\)/);
  });

  it("compiles a canonical multi-module bundle", () => {
    const serialized = serializeTripBundleV1({
      entryModule: "Main",
      target: { kind: "x86_64-unknown-linux-gnu" },
      mainWrapper: { kind: "c-main" },
      modules: [
        {
          name: "Main",
          source: `module Main
import Lib seven
export main
poly main = seven
`,
        },
        {
          name: "Lib",
          source: `module Lib
export seven
poly seven = #u8(7)
`,
        },
      ],
    });
    const text = decode(serialized);
    assert.ok(text.indexOf("module Lib ") < text.indexOf("module Main "));
    assert.deepEqual(
      parseTripBundleV1(serialized).modules.map((module) => module.name),
      ["Lib", "Main"],
    );

    const llvm = compileTripBundleV1ToLlvm(serialized);
    assert.match(llvm, /target triple = "x86_64-unknown-linux-gnu"/);
    assert.match(llvm, /define i8 @trip_fn_Lib_seven\(\)/);
    assert.match(llvm, /define i8 @trip_fn_Main_main\(\)/);
  });

  it("compiles a stdin List U8 wrapper bundle", () => {
    const llvm = compileTripBundleV1ToLlvm(
      serializeTripBundleV1({
        entryModule: "Main",
        target: { kind: "x86_64-unknown-linux-gnu" },
        mainWrapper: { kind: "stdin-list-u8" },
        modules: [
          {
            name: "Main",
            source: `module Main
import Prelude List
export main
poly main = \\source : List U8 => #u8(0)
`,
          },
        ],
      }),
    );
    assert.match(llvm, /declare ptr @trip_read_stdin_list_u8\(\)/);
    assert.match(llvm, /%trip_source = call ptr @trip_read_stdin_list_u8\(\)/);
    assert.match(llvm, /call i8 @trip_fn_Main_main\(ptr %trip_source\)/);
  });

  it("compiles the bootstrap-facing bundle fixture to LLVM IR", () => {
    const bundleBytes = readFileSync(
      join(fixtureDir, "bootstrap-summary.bundle-v1"),
    );
    const llvm = compileTripBundleV1ToLlvm(bundleBytes);
    assert.match(llvm, /target triple = "x86_64-unknown-linux-gnu"/);
    assert.match(llvm, /declare ptr @trip_read_stdin_list_u8\(\)/);
    assert.match(llvm, /define i8 @trip_fn_Lib_seven\(\)/);
    assert.match(llvm, /define i8 @trip_fn_Main_main\(ptr %v\d+\)/);
  });

  it("rejects a missing entry module", () => {
    assert.throws(
      () =>
        serializeTripBundleV1({
          ...bundle,
          entryModule: "Other",
        }),
      {
        name: TripBundleV1Error.name,
        message: /Entry module Other is not present/,
      },
    );
  });

  it("rejects malformed bundles", () => {
    const mainSource = `module Main
export main
poly main = #u8(7)
`;
    const libSource = `module Lib
export seven
poly seven = #u8(7)
`;
    const cases: Array<[string, Uint8Array, RegExp]> = [
      [
        "bad magic",
        encode(
          bundleSource({
            modules: [{ name: "Main", source: mainSource }],
          }).replace("TRIP-BUNDLE-V1", "TRIP-BUNDLE-X"),
        ),
        /Invalid bundle-v1 magic/,
      ],
      [
        "bad directive order",
        encode(
          [
            "TRIP-BUNDLE-V1",
            "target x86_64-unknown-linux-gnu",
            "entry Main",
            "wrapper c-main",
            "modules 0",
          ].join("\n"),
        ),
        /Expected bundle-v1 directive 'entry'/,
      ],
      [
        "duplicate module",
        encode(
          bundleSource({
            modules: [
              { name: "Main", source: mainSource },
              { name: "Main", source: mainSource },
            ],
          }),
        ),
        /Duplicate module in bundle-v1: Main/,
      ],
      [
        "missing entry",
        encode(
          bundleSource({
            entry: "Main",
            modules: [{ name: "Lib", source: libSource }],
          }),
        ),
        /Entry module Main is not present/,
      ],
      [
        "wrong byte length",
        encode(
          [
            "TRIP-BUNDLE-V1",
            "entry Main",
            "target x86_64-unknown-linux-gnu",
            "wrapper c-main",
            "modules 1",
            "module Main 999",
            mainSource,
          ].join("\n"),
        ),
        /ended before 999 byte/,
      ],
      [
        "non-canonical module order",
        encode(
          bundleSource({
            modules: [
              { name: "Main", source: mainSource },
              { name: "Lib", source: libSource },
            ],
          }),
        ),
        /modules must be sorted/,
      ],
      [
        "trailing byte",
        encode(decode(serializeTripBundleV1(bundle)) + " "),
        /trailing bytes/,
      ],
      [
        "trailing newline",
        encode(decode(serializeTripBundleV1(bundle)) + "\n"),
        /trailing bytes/,
      ],
      [
        "unsupported target",
        encode(
          bundleSource({
            target: "mips-unknown",
            modules: [{ name: "Main", source: mainSource }],
          }),
        ),
        /Unsupported bundle-v1 LLVM target/,
      ],
      [
        "unsupported wrapper",
        encode(
          bundleSource({
            wrapper: "argv",
            modules: [{ name: "Main", source: mainSource }],
          }),
        ),
        /Unsupported bundle-v1 wrapper kind/,
      ],
    ];

    for (const [name, bytes, message] of cases) {
      assert.throws(
        () => parseTripBundleV1(bytes),
        {
          name: TripBundleV1Error.name,
          message,
        },
        name,
      );
    }

    assert.throws(
      () =>
        parseTripBundleV1(
          new Uint8Array([
            ...encode(
              [
                "TRIP-BUNDLE-V1",
                "entry Main",
                "target x86_64-unknown-linux-gnu",
                "wrapper c-main",
                "modules 1",
                "module Main 1",
              ].join("\n") + "\n",
            ),
            0xff,
          ]),
        ),
      {
        name: TripBundleV1Error.name,
        message: /non-ASCII byte/,
      },
    );
  });

  it("rejects a module record whose source declares another module", () => {
    assert.throws(
      () =>
        compileTripBundleV1ToLlvm(
          serializeTripBundleV1({
            entryModule: "Other",
            target: { kind: "x86_64-unknown-linux-gnu" },
            modules: [
              {
                name: "Other",
                source: `module Main
export main
poly main = #u8(7)
`,
              },
            ],
          }),
        ),
      {
        message: /module Other source declares module Main/,
      },
    );
  });

  it("rejects native-v1 function value shapes through the bundle path", () => {
    assert.throws(
      () =>
        compileTripBundleV1ToLlvm(
          serializeTripBundleV1({
            entryModule: "Main",
            target: { kind: "x86_64-unknown-linux-gnu" },
            modules: [
              {
                name: "Main",
                source: `module Main
data Box = MkBox (U8 -> U8)
export main
poly main = #u8(0)
`,
              },
            ],
          }),
        ),
      {
        name: NativeV1SubsetError.name,
        message: /field 0 of constructor Main\.Box\.MkBox/,
      },
    );
  });
});
