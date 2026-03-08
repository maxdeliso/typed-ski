/**
 * Tests for the link-time duplicate advisory pass (LDUP001, clustering, suppression).
 */

import { expect } from "chai";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { SKITerminalSymbol } from "../../lib/ski/terminal.ts";

type TestTripCObject =
  & Omit<TripCObject, "dataDefinitions">
  & Partial<Pick<TripCObject, "dataDefinitions">>;

function withDataDefinitions(object: TestTripCObject): TripCObject {
  return {
    ...object,
    dataDefinitions: object.dataDefinitions ?? [],
  };
}

Deno.test("Link-time duplicate detection", async (t) => {
  await t.step(
    "duplicate-check without allowDuplicateExports still throws on ambiguous export",
    () => {
      const I = { kind: "terminal" as const, sym: SKITerminalSymbol.I };
      const a = {
        module: "A",
        exports: ["foo", "main"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          foo: { kind: "combinator" as const, name: "foo", term: I },
          main: { kind: "combinator" as const, name: "main", term: I },
        },
      };
      const b = {
        module: "B",
        exports: ["foo"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          foo: { kind: "combinator" as const, name: "foo", term: I },
        },
      };
      expect(() =>
        linkModules(
          [
            { name: "A", object: withDataDefinitions(a) },
            { name: "B", object: withDataDefinitions(b) },
          ],
          { duplicateDetection: { enabled: true } },
        )
      ).to.throw(/Ambiguous export 'foo'/);
    },
  );

  await t.step(
    "exact duplicate names: two modules both export addBin → one grouped LDUP001",
    () => {
      const I = { kind: "terminal" as const, sym: SKITerminalSymbol.I };
      const modulePrelude = {
        module: "Prelude",
        exports: ["addBin", "main"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          addBin: {
            kind: "combinator" as const,
            name: "addBin",
            term: I,
          },
          main: {
            kind: "combinator" as const,
            name: "main",
            term: I,
          },
        },
      };
      const moduleBin = {
        module: "Bin",
        exports: ["addBin"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          addBin: {
            kind: "combinator" as const,
            name: "addBin",
            term: I,
          },
        },
      };

      const result = linkModules(
        [
          { name: "Prelude", object: withDataDefinitions(modulePrelude) },
          { name: "Bin", object: withDataDefinitions(moduleBin) },
        ],
        { allowDuplicateExports: true, duplicateDetection: { enabled: true } },
      );

      expect(result.expression).to.be.a("string");
      expect(result.expression.length).to.be.greaterThan(0);

      const dupWarnings = result.diagnostics.filter((d) =>
        d.code === "LDUP001"
      );
      expect(dupWarnings.length).to.be.greaterThanOrEqual(
        1,
        "expect at least one LDUP001 when both modules export addBin (and main)",
      );
      const first = dupWarnings[0];
      expect(first?.primaryModule).to.equal(
        "Prelude",
        "diagnostic should identify primary module",
      );
      expect(first?.relatedModules).to.deep.equal(
        ["Bin"],
        "diagnostic should list related modules",
      );
      expect(first?.relatedSymbols).to.be.an("array");
      const addBinPairs = first!.relatedSymbols!.filter((s) =>
        s.symbol === "addBin"
      );
      expect(addBinPairs.length).to.equal(
        2,
        "LDUP001 should group Prelude.addBin and Bin.addBin",
      );
    },
  );

  await t.step(
    "whitelisted shim: Prelude marked as shim for Bin → no duplicate warning",
    () => {
      const I = { kind: "terminal" as const, sym: SKITerminalSymbol.I };
      const modulePrelude = {
        module: "Prelude",
        exports: ["addBin", "main"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          addBin: { kind: "combinator" as const, name: "addBin", term: I },
          main: { kind: "combinator" as const, name: "main", term: I },
        },
      };
      const moduleBin = {
        module: "Bin",
        exports: ["addBin"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          addBin: { kind: "combinator" as const, name: "addBin", term: I },
        },
      };

      const result = linkModules(
        [
          { name: "Prelude", object: withDataDefinitions(modulePrelude) },
          { name: "Bin", object: withDataDefinitions(moduleBin) },
        ],
        {
          allowDuplicateExports: true,
          duplicateDetection: {
            enabled: true,
            moduleShimFor: { Prelude: ["Bin"] },
          },
        },
      );

      const dupWarnings = result.diagnostics.filter((d) =>
        d.code === "LDUP001"
      );
      expect(dupWarnings.length).to.equal(
        0,
        "moduleShimFor Prelude→Bin should suppress duplicate warnings",
      );
    },
  );

  await t.step(
    "common primitives: both modules export fst/snd in whitelist → no warning",
    () => {
      const K = { kind: "terminal" as const, sym: SKITerminalSymbol.K };
      const I = { kind: "terminal" as const, sym: SKITerminalSymbol.I };
      const modPrelude = {
        module: "Prelude",
        exports: ["fst", "snd", "main"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          fst: { kind: "combinator" as const, name: "fst", term: K },
          snd: { kind: "combinator" as const, name: "snd", term: I },
          main: { kind: "combinator" as const, name: "main", term: I },
        },
      };
      const modUtils = {
        module: "Utils",
        exports: ["fst", "snd"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          fst: { kind: "combinator" as const, name: "fst", term: K },
          snd: { kind: "combinator" as const, name: "snd", term: I },
        },
      };

      const result = linkModules(
        [
          { name: "Prelude", object: withDataDefinitions(modPrelude) },
          { name: "Utils", object: withDataDefinitions(modUtils) },
        ],
        {
          allowDuplicateExports: true,
          duplicateDetection: {
            enabled: true,
            commonPrimitiveSymbols: new Set([
              "fst",
              "snd",
              "id",
              "const",
              "true",
              "false",
            ]),
          },
        },
      );

      const dupForFstSnd = result.diagnostics.filter(
        (d) =>
          d.code === "LDUP001" &&
          d.relatedSymbols?.some((s) =>
            s.symbol === "fst" || s.symbol === "snd"
          ),
      );
      expect(dupForFstSnd.length).to.equal(
        0,
        "commonPrimitiveSymbols fst/snd should suppress duplicate warnings",
      );
    },
  );

  await t.step(
    "different names, identical body (Phase 2): eqBin and equalBin same SKI → one warning",
    () => {
      const sameBody = { kind: "terminal" as const, sym: SKITerminalSymbol.I };
      const modA = {
        module: "A",
        exports: ["eqBin", "main"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          eqBin: { kind: "combinator" as const, name: "eqBin", term: sameBody },
          main: { kind: "combinator" as const, name: "main", term: sameBody },
        },
      };
      const modB = {
        module: "B",
        exports: ["equalBin"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          equalBin: {
            kind: "combinator" as const,
            name: "equalBin",
            term: sameBody,
          },
        },
      };

      const result = linkModules(
        [
          { name: "A", object: withDataDefinitions(modA) },
          { name: "B", object: withDataDefinitions(modB) },
        ],
        { duplicateDetection: { enabled: true } },
      );

      expect(result.expression).to.be.a("string");
      const bodyMatchWarnings = result.diagnostics.filter(
        (d) =>
          d.code === "LDUP001" &&
          d.relatedSymbols?.some((s) =>
            s.symbol === "eqBin" || s.symbol === "equalBin"
          ),
      );
      expect(bodyMatchWarnings.length).to.be.greaterThanOrEqual(
        1,
        "expect LDUP001 for same body (eqBin/equalBin)",
      );
    },
  );

  await t.step(
    "body-hash message qualifies same SKI body vs same abstraction",
    () => {
      const I = { kind: "terminal" as const, sym: SKITerminalSymbol.I };
      const modList = {
        module: "List",
        exports: ["nil", "main"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          nil: { kind: "combinator" as const, name: "nil", term: I },
          main: { kind: "combinator" as const, name: "main", term: I },
        },
      };
      const modTree = {
        module: "Tree",
        exports: ["empty"],
        imports: [] as { name: string; from: string }[],
        definitions: {
          empty: { kind: "combinator" as const, name: "empty", term: I },
        },
      };

      const result = linkModules(
        [
          { name: "List", object: withDataDefinitions(modList) },
          { name: "Tree", object: withDataDefinitions(modTree) },
        ],
        { duplicateDetection: { enabled: true } },
      );

      const bodyMatch = result.diagnostics.find(
        (d) =>
          d.code === "LDUP001" &&
          d.relatedSymbols?.some((s) =>
            s.symbol === "nil" || s.symbol === "empty"
          ),
      );
      expect(bodyMatch, "expect one body-hash diagnostic for nil/empty").to.not
        .be.undefined;
      expect(bodyMatch!.message).to.include(
        "Same SKI body",
        "message must not imply consolidation",
      );
      expect(bodyMatch!.hint).to.include(
        "distinct types",
        "hint must qualify that same encoding may be different abstractions",
      );
    },
  );
});
