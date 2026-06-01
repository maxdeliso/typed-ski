import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  discoverTripFiles,
  formatTripSource,
  lintTripSource,
} from "../../lib/improvize/index.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
} from "../util/tripcHarness.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseTripLang } from "../../lib/parser/tripLang.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

describe("improvize formatter", () => {
  it("preserves comments while canonicalizing top-level layout", () => {
    const input = `module M
-- leading data
data Maybe A = Nothing | Just A
poly id = #A=>\\x:A=>x  -- identity
`;

    const result = formatTripSource(input);

    assert.equal(
      result.formatted,
      `module M

-- leading data
data Maybe A =
  | Nothing
  | Just A

poly id =
  #A => \\x : A => x -- identity
`,
    );
  });

  it("is idempotent", () => {
    const input = `module M
data Result E T = Err E | Ok T
poly main =
  match x [Result E T] {
    | Err e => e
    | Ok t => t
  }
`;
    const once = formatTripSource(input).formatted;
    const twice = formatTripSource(once).formatted;
    assert.equal(twice, once);
  });

  it("keeps parse-equivalent programs parseable", () => {
    const input = `module M
import Prelude U8
export main
poly main = #u8(1)
`;
    const formatted = formatTripSource(input).formatted;
    assert.deepEqual(parseTripLang(formatted), parseTripLang(input));
  });

  it("is idempotent and parse-equivalent across the Trip corpus", async () => {
    const files = await discoverTripFiles([workspaceRoot]);
    const idempotenceFailures: string[] = [];
    const parseFailures: string[] = [];
    let parseChecked = 0;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const once = formatTripSource(source).formatted;
      const twice = formatTripSource(once).formatted;
      if (twice !== once) {
        idempotenceFailures.push(file);
      }

      let before: unknown;
      try {
        before = parseTripLang(source);
      } catch {
        continue;
      }
      parseChecked++;

      try {
        assert.deepEqual(parseTripLang(once), before);
      } catch {
        parseFailures.push(file);
      }
    }

    assert.equal(idempotenceFailures.length, 0, idempotenceFailures.join("\n"));
    assert.equal(parseFailures.length, 0, parseFailures.join("\n"));
    assert.ok(files.length > 0);
    assert.ok(parseChecked > 0);
  });
});

describe("improvize linter", () => {
  it("reports and fixes canonical byte literal spelling", () => {
    const source = `module M
poly main = 72
`;
    const result = lintTripSource(source, { fix: true });
    assert.deepEqual(
      result.diagnostics.map((diag) => diag.code),
      ["trip-u8-literal"],
    );
    assert.match(result.fixed, /#u8\(72\)/);
  });

  it("reports semantic hints and applies conservative fixes", () => {
    const source = `module M
import Prelude and
import Prelude true
poly f = \\x : A => g x
poly main = and true value
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-eta-reduce"),
    );
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-bool-identity"),
    );
    assert.match(result.fixed, /poly f =\n  g\n/);
    assert.match(result.fixed, /poly main =\n  value\n/);
  });

  it("keeps if simplification diagnostic-only", () => {
    const source = `module M
import Prelude if
poly main = if [A] true t f
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-if-constant"),
    );
    assert.match(result.fixed, /if \[A\] true t f/);
  });

  it("reports and fixes pair types to syntactic sugar", () => {
    const source = `module M
poly x : Pair Bin Bin = y
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-pair-type"),
    );
    assert.match(result.fixed, /poly x : \(Bin, Bin\) =\s+y/);
  });

  it("reports and fixes MkPair to syntactic sugar", () => {
    const source = `module M
poly main = MkPair [Bin] [Bin] a b
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-pair-literal"),
    );
    assert.match(result.fixed, /\{Bin, Bin \| a, b\}/);
  });

  it("reports and fixes nested cons/nil to list literals", () => {
    const source = `module M
poly main = cons [Bin] a (cons [Bin] b (nil [Bin]))
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-list-literal"),
    );
    assert.match(result.fixed, /\{Bin \| a b\}/);
  });

  it("reports and fixes U8 list to double-quoted string literals", () => {
    const source = `module M
poly main = cons [U8] 'h' (cons [U8] 'i' (nil [U8]))
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-string-literal"),
    );
    assert.match(result.fixed, /"hi"/);
  });

  it("reports and fixes U8 list literals to double-quoted string literals", () => {
    const source = `module M
poly main = {U8 | 'h' 'e' 'l' 'l' 'o'}
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-string-literal"),
    );
    assert.match(result.fixed, /"hello"/);
  });

  it("reports and flattens append chains", () => {
    const source = `module M
poly main = append [Bin] {Bin | a} {Bin | b}
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-list-append"),
    );
    assert.match(result.fixed, /\{Bin \| a b\}/);
  });

  it("reports and fixes degenerate if chains to cond blocks", () => {
    const source = `module M
poly main =
  if [Lower] c1
    (\\u : U8 => t1)
    (\\u : U8 =>
      if [Lower] c2
        (\\u : U8 => t2)
        (\\u : U8 => d))
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-degenerate-if"),
    );
    assert.match(result.fixed, /cond \[Lower\]/);
    assert.match(result.fixed, /\| c1 => t1/);
    assert.match(result.fixed, /\| c2 => t2/);
    assert.match(result.fixed, /\| otherwise => d/);
  });

  it("does not rewrite if chains with nonstandard delay binders", () => {
    const source = `module M
poly main =
  if [Lower] c1
    (\\x : U8 => t1)
    (\\x : U8 =>
      if [Lower] c2
        (\\x : U8 => t2)
        (\\x : U8 => d))
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      !result.diagnostics.some((diag) => diag.code === "trip-degenerate-if"),
    );
    assert.doesNotMatch(result.fixed, /cond \[Lower\]/);
  });

  it("does not rewrite if chains when delay binders are used", () => {
    const source = `module M
poly main =
  if [Lower] c1
    (\\u : U8 => u)
    (\\u : U8 =>
      if [Lower] c2
        (\\u : U8 => t2)
        (\\u : U8 => d))
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      !result.diagnostics.some((diag) => diag.code === "trip-degenerate-if"),
    );
    assert.doesNotMatch(result.fixed, /cond \[Lower\]/);
  });

  it("reports and fixes nested monadic match/if chains to do blocks", () => {
    const source = `module M
poly main =
  match (readLine input) [Result (List U8) BundleSummary] {
    | Err e => Err [List U8] [BundleSummary] e
    | Ok magicRes =>
      match magicRes [Result (List U8) BundleSummary] {
        | MkLine magic afterMagic =>
          if [Result (List U8) BundleSummary] true
            (\\u : U8 => Ok [List U8] [BundleSummary] val)
            (\\u : U8 => Err [List U8] [BundleSummary] "bad magic")
      }
  }
`;
    const result = lintTripSource(source, { fix: true });
    assert.ok(
      result.diagnostics.some((diag) => diag.code === "trip-degenerate-do"),
    );
    assert.match(result.fixed, /do \[Result \(List U8\) BundleSummary\]/);
    assert.match(result.fixed, /magicRes <- \(readLine input\)/);
    assert.match(result.fixed, /MkLine magic afterMagic = magicRes/);
    assert.match(result.fixed, /assert true else "bad magic"/);
    assert.match(result.fixed, /return Ok \[List U8\] \[BundleSummary\] val/);
  });
});

describe("improvize file discovery", () => {
  it("recurses into trip files and skips generated directories", async () => {
    const workspace = await createTempWorkspace("typed-ski-improvize-");
    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "pkg"), {
        recursive: true,
      });
      await writeFile(join(workspace, "src", "A.trip"), "module A\n", "utf8");
      await writeFile(
        join(workspace, "node_modules", "pkg", "B.trip"),
        "module B\n",
        "utf8",
      );

      const files = await discoverTripFiles([workspace]);
      assert.deepEqual(
        files.map((file) => file.slice(workspace.length + 1)),
        [join("src", "A.trip")],
      );
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});
