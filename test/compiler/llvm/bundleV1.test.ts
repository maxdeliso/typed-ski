import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  summarizeTripBundleV1ParsedModules,
  TripBundleV1Error,
  type TripBundleV1,
} from "../../../lib/compiler/index.ts";
import { NativeV1SubsetError } from "../../../lib/minicore/index.ts";
import {
  compileLlvmToExecutable,
  compileTripToLlvm,
  loadCommonModules,
  runExecutable,
} from "./nativeHarness.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");
const projectRoot = join(__dirname, "../../..");

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

function realBootstrapModuleSource(name: string): string {
  const directPath = join(projectRoot, "lib", `${name.toLowerCase()}.trip`);
  try {
    return readFileSync(directPath, "utf8");
  } catch {
    return readFileSync(
      join(
        projectRoot,
        "lib",
        "compiler",
        `${name.charAt(0).toLowerCase()}${name.slice(1)}.trip`,
      ),
      "utf8",
    );
  }
}

function realBootstrapBundle(moduleNames: string[]): Uint8Array {
  return serializeTripBundleV1({
    entryModule: moduleNames.at(-1) ?? "Prelude",
    target: { kind: "x86_64-unknown-linux-gnu" },
    mainWrapper: { kind: "stdin-list-u8" },
    modules: moduleNames.map((name) => ({
      name,
      source: realBootstrapModuleSource(name),
    })),
  });
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

  it("summarizes parsed modules in the bootstrap-facing bundle fixture", () => {
    const bundleBytes = readFileSync(
      join(fixtureDir, "bootstrap-summary.bundle-v1"),
    );
    const expectedSummary = readFileSync(
      join(fixtureDir, "bootstrap-parse-summary.txt"),
      "utf8",
    );

    assert.equal(
      summarizeTripBundleV1ParsedModules(bundleBytes),
      expectedSummary,
    );
  });

  it("host parsed module summaries cover generated real bootstrap source bundles", () => {
    const goldenCases: Array<[string, string[], string]> = [
      ["Prelude", ["Prelude"], "bootstrap-parse-summary-prelude.txt"],
      [
        "Prelude + Bin + Lexer",
        ["Prelude", "Bin", "Lexer"],
        "bootstrap-parse-summary-prelude-bin-lexer.txt",
      ],
    ];

    for (const [name, moduleNames, goldenFile] of goldenCases) {
      assert.equal(
        summarizeTripBundleV1ParsedModules(realBootstrapBundle(moduleNames)),
        readFileSync(join(fixtureDir, goldenFile), "utf8"),
        name,
      );
    }

    const closureCases = [
      ["Prelude"],
      ["Prelude", "Bin"],
      ["Prelude", "Bin", "Lexer"],
      ["Prelude", "Bin", "Lexer", "Parser"],
      ["Prelude", "Bin", "Lexer", "Parser", "BundleSummary"],
      [
        "Prelude",
        "Bin",
        "Lexer",
        "Parser",
        "BundleSummary",
        "BundleParseSummary",
      ],
    ];

    for (const moduleNames of closureCases) {
      assert.match(
        summarizeTripBundleV1ParsedModules(realBootstrapBundle(moduleNames)),
        /^OK\nversion bundle-parse-summary-v1\n/,
        moduleNames.join(" + "),
      );
    }
  });

  it("preserves declaration source order in host parsed module summaries", () => {
    const source = `module Main
import Alpha one
import Beta two
export second
export first
data Box = MkBox U8 | MkOther
type Alias = U8
opaque type Handle
native secondNative : U8
native firstNative : U8
combinator raw = S
poly zed = #u8(0)
poly alpha = #u8(1)
`;
    const summary = summarizeTripBundleV1ParsedModules(
      serializeTripBundleV1({
        entryModule: "Main",
        target: { kind: "x86_64-unknown-linux-gnu" },
        modules: [{ name: "Main", source }],
      }),
    );

    assert.equal(
      summary,
      [
        "OK",
        "version bundle-parse-summary-v1",
        "entry Main",
        "target x86_64-unknown-linux-gnu",
        "wrapper none",
        "modules 1",
        "module Main",
        "declared Main",
        "imports 2",
        "import Alpha one",
        "import Beta two",
        "exports 2",
        "export second",
        "export first",
        "data 1",
        "data Box",
        "ctor MkBox 1",
        "ctor MkOther 0",
        "type 1",
        "type Alias",
        "opaque 1",
        "opaque Handle",
        "native 2",
        "native secondNative",
        "native firstNative",
        "poly 2",
        "poly zed",
        "poly alpha",
        "combinator 1",
        "combinator raw",
        "",
      ].join("\n"),
    );
  });

  it("host parsed module summaries reject malformed module sources deterministically", () => {
    const cases: Array<[string, Uint8Array, RegExp]> = [
      [
        "malformed syntax",
        serializeTripBundleV1({
          entryModule: "Main",
          target: { kind: "x86_64-unknown-linux-gnu" },
          modules: [
            {
              name: "Main",
              source: `module Main
export main
poly main = \\x : U8 =>
`,
            },
          ],
        }),
        /Parse error/,
      ],
      [
        "source module mismatch",
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
        /source module mismatch/,
      ],
      [
        "malformed native syntax",
        serializeTripBundleV1({
          entryModule: "Main",
          target: { kind: "x86_64-unknown-linux-gnu" },
          modules: [
            {
              name: "Main",
              source: `module Main
native readOne = U8
`,
            },
          ],
        }),
        /Parse error/,
      ],
      [
        "malformed opaque syntax",
        serializeTripBundleV1({
          entryModule: "Main",
          target: { kind: "x86_64-unknown-linux-gnu" },
          modules: [
            {
              name: "Main",
              source: `module Main
opaque Handle
`,
            },
          ],
        }),
        /Parse error/,
      ],
      [
        "non-ASCII source byte",
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
        /non-ASCII byte/,
      ],
    ];

    for (const [name, bytes, message] of cases) {
      assert.throws(
        () => summarizeTripBundleV1ParsedModules(bytes),
        {
          name: TripBundleV1Error.name,
          message,
        },
        name,
      );
    }
  });

  it("Trip-side native parser summary executable matches the golden fixture", async () => {
    const bundleBytes = readFileSync(
      join(fixtureDir, "bootstrap-summary.bundle-v1"),
    );
    const expectedSummary = readFileSync(
      join(fixtureDir, "bootstrap-summary.txt"),
      "utf8",
    );
    assert.equal(
      summarizeTripBundleV1(bundleBytes),
      expectedSummary.replace(/\n$/, ""),
    );

    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-bundle-summary-"));
    try {
      const exePath = await compileBundleSummaryExecutable(tempDir);
      const result = runExecutable(exePath, bundleBytes);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, expectedSummary);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Trip-side native parsed module summary executable matches the golden fixture", async () => {
    const bundleBytes = readFileSync(
      join(fixtureDir, "bootstrap-summary.bundle-v1"),
    );
    const expectedSummary = readFileSync(
      join(fixtureDir, "bootstrap-parse-summary.txt"),
      "utf8",
    );
    assert.equal(
      summarizeTripBundleV1ParsedModules(bundleBytes),
      expectedSummary,
    );

    const tempDir = await mkdtemp(
      join(tmpdir(), "typed-ski-bundle-parse-summary-"),
    );
    try {
      const exePath = await compileBundleParseSummaryExecutable(tempDir);
      const result = runExecutable(exePath, bundleBytes);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, expectedSummary);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Trip-side native parsed module summary executable matches generated real bootstrap source bundles", async () => {
    const moduleSets = [
      ["Prelude"],
      ["Prelude", "Bin"],
      ["Prelude", "Bin", "Lexer"],
    ];
    const tempDir = await mkdtemp(
      join(tmpdir(), "typed-ski-bundle-parse-summary-real-"),
    );
    try {
      const exePath = await compileBundleParseSummaryExecutable(tempDir);
      for (const moduleNames of moduleSets) {
        const bundleBytes = realBootstrapBundle(moduleNames);
        const expectedSummary = summarizeTripBundleV1ParsedModules(bundleBytes);
        const result = runExecutable(exePath, bundleBytes);
        assert.equal(result.status, 0, moduleNames.join(" + "));
        assert.equal(result.stderr, "", moduleNames.join(" + "));
        assert.equal(result.stdout, expectedSummary, moduleNames.join(" + "));
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Trip-side native parsed module summary executable rejects malformed sources", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "typed-ski-bundle-parse-summary-errors-"),
    );
    try {
      const exePath = await compileBundleParseSummaryExecutable(tempDir);
      const cases: Array<[string, Uint8Array, RegExp]> = [
        [
          "malformed syntax",
          serializeTripBundleV1({
            entryModule: "Main",
            target: { kind: "x86_64-unknown-linux-gnu" },
            modules: [
              {
                name: "Main",
                source: `module Main
export main
poly main = \\x : U8 =>
`,
              },
            ],
          }),
          /ERR:Parse error/,
        ],
        [
          "source module mismatch",
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
          /ERR:source module mismatch/,
        ],
        [
          "malformed native syntax",
          serializeTripBundleV1({
            entryModule: "Main",
            target: { kind: "x86_64-unknown-linux-gnu" },
            modules: [
              {
                name: "Main",
                source: `module Main
native readOne = U8
`,
              },
            ],
          }),
          /ERR:Parse error/,
        ],
        [
          "malformed opaque syntax",
          serializeTripBundleV1({
            entryModule: "Main",
            target: { kind: "x86_64-unknown-linux-gnu" },
            modules: [
              {
                name: "Main",
                source: `module Main
opaque Handle
`,
              },
            ],
          }),
          /ERR:Parse error/,
        ],
        [
          "non-ASCII source byte",
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
          /ERR:non-ascii byte/,
        ],
      ];

      for (const [name, bytes, message] of cases) {
        const result = runExecutable(exePath, bytes);
        assert.equal(result.status, 0, name);
        assert.equal(result.stderr, "", name);
        assert.match(result.stdout, message, name);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Trip-side native parser rejects malformed bundles", async () => {
    const mainSource = `module Main
export main
poly main = #u8(7)
`;
    const libSource = `module Lib
export seven
poly seven = #u8(7)
`;
    const tempDir = await mkdtemp(
      join(tmpdir(), "typed-ski-bundle-summary-errors-"),
    );
    try {
      const exePath = await compileBundleSummaryExecutable(tempDir);
      const cases: Array<[string, Uint8Array, RegExp]> = [
        [
          "bad magic",
          encode(
            bundleSource({
              modules: [{ name: "Main", source: mainSource }],
            }).replace("TRIP-BUNDLE-V1", "TRIP-BUNDLE-X"),
          ),
          /ERR:bad magic/,
        ],
        [
          "unsupported target",
          encode(
            bundleSource({
              target: "mips-unknown",
              modules: [{ name: "Main", source: mainSource }],
            }),
          ),
          /ERR:bad target/,
        ],
        [
          "unsupported wrapper",
          encode(
            bundleSource({
              wrapper: "argv",
              modules: [{ name: "Main", source: mainSource }],
            }),
          ),
          /ERR:bad wrapper/,
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
          /ERR:duplicate module/,
        ],
        [
          "missing entry",
          encode(
            bundleSource({
              entry: "Main",
              modules: [{ name: "Lib", source: libSource }],
            }),
          ),
          /ERR:missing entry/,
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
          /ERR:source ended early/,
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
          /ERR:module order/,
        ],
        [
          "trailing byte",
          encode(decode(serializeTripBundleV1(bundle)) + " "),
          /ERR:trailing bytes/,
        ],
        [
          "non-ASCII source byte",
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
          /ERR:non-ascii byte/,
        ],
        [
          "source module mismatch",
          serializeTripBundleV1({
            entryModule: "Other",
            target: { kind: "x86_64-unknown-linux-gnu" },
            modules: [
              {
                name: "Other",
                source: mainSource,
              },
            ],
          }),
          /ERR:source module mismatch/,
        ],
      ];

      for (const [name, bytes, message] of cases) {
        const result = runExecutable(exePath, bytes);
        assert.equal(result.status, 0, name);
        assert.equal(result.stderr, "", name);
        assert.match(result.stdout, message, name);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

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
    assert.match(
      llvm,
      /declare (noalias )?ptr @trip_read_stdin_list_u8\(\)( nounwind)?/,
    );
    assert.match(llvm, /%trip_source = call ptr @trip_read_stdin_list_u8\(\)/);
    assert.match(llvm, /call i8 @trip_fn_Main_main\(ptr %trip_source\)/);
  });

  it("compiles the bootstrap-facing bundle fixture to LLVM IR", () => {
    const bundleBytes = readFileSync(
      join(fixtureDir, "bootstrap-summary.bundle-v1"),
    );
    const llvm = compileTripBundleV1ToLlvm(bundleBytes);
    assert.match(llvm, /target triple = "x86_64-unknown-linux-gnu"/);
    assert.match(
      llvm,
      /declare (noalias )?ptr @trip_read_stdin_list_u8\(\)( nounwind)?/,
    );
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

async function compileBundleSummaryExecutable(
  tempDir: string,
): Promise<string> {
  const source = readFileSync(
    join(__dirname, "../../../lib/compiler/bundleSummary.trip"),
    "utf8",
  );
  const llvm = await compileTripToLlvm(source, {
    entryModule: "BundleSummary",
    moduleSources: await loadCommonModules(["Prelude", "Bin"]),
    mainWrapper: { kind: "stdin-list-u8" },
  });
  const llPath = join(tempDir, "bundle-summary.ll");
  await writeFile(llPath, llvm, "utf8");
  return compileLlvmToExecutable(llPath);
}

async function compileBundleParseSummaryExecutable(
  tempDir: string,
): Promise<string> {
  const source = readFileSync(
    join(__dirname, "../../../lib/compiler/bundleParseSummary.trip"),
    "utf8",
  );
  const llvm = await compileTripToLlvm(source, {
    entryModule: "BundleParseSummary",
    moduleSources: await loadCommonModules([
      "Prelude",
      "Bin",
      "Lexer",
      "Parser",
      "BundleSummary",
    ]),
    mainWrapper: { kind: "stdin-list-u8" },
  });
  const llPath = join(tempDir, "bundle-parse-summary.ll");
  await writeFile(llPath, llvm, "utf8");
  return compileLlvmToExecutable(llPath);
}
