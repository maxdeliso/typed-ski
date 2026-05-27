/**
 * Regression tests for higher-order specialization in fromTrip.ts.
 *
 * When a polymorphic function (e.g. `Avl.lookup [K] [V] lteKey ...`)
 * is specialized at a call site that fixes `lteKey` to a concrete
 * function (e.g. `Prelude.lteListU8 : List U8 -> List U8 -> Bool`),
 * the type-arg substitution (`K -> List U8`, `V -> ...`) must be
 * applied across the specialized callee's body. Without that, the
 * specialized body still has parameters typed as `K` while it calls
 * a function expecting `data#1<u8>`, and `validateBlockModule` rejects
 * the resulting block IR with:
 *
 *   call Prelude.lteListU8 in Avl.lookup$lteKey=Prelude.lteListU8...
 *   arg 0 type mismatch: expected data#1<u8>, got K
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { compileTripSourceToLlvm } from "../../lib/compiler/index.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { loadTripSourceFile } from "../../lib/tripSourceLoader.ts";

const PRELUDE_URL = join(workspaceRoot, "lib", "prelude.trip");
const NAT_URL = join(workspaceRoot, "lib", "nat.trip");
const BIN_URL = join(workspaceRoot, "lib", "bin.trip");
const AVL_URL = join(workspaceRoot, "lib", "avl.trip");

const PROBE_SOURCE = `module Probe
import Prelude List
import Prelude U8
import Prelude Maybe
import Prelude lteListU8
import Avl lookup
import Avl empty

export main

poly main = \\k : List U8 =>
  lookup [List U8] [U8] lteListU8 k (empty [List U8] [U8])
`;

describe("MiniCore higher-order specialization", () => {
  it("specializes Avl.lookup with Prelude.lteListU8 and propagates K=List U8", async () => {
    const moduleSources = await Promise.all([
      loadTripSourceFile(PRELUDE_URL).then((source) => ({
        name: "Prelude",
        source,
      })),
      loadTripSourceFile(NAT_URL).then((source) => ({
        name: "Nat",
        source,
      })),
      loadTripSourceFile(BIN_URL).then((source) => ({
        name: "Bin",
        source,
      })),
      loadTripSourceFile(AVL_URL).then((source) => ({
        name: "Avl",
        source,
      })),
    ]);

    const modules = [...moduleSources, { name: "Probe", source: PROBE_SOURCE }];
    const program = compileMiniCoreModules(modules, "Probe", {
      requireNullaryEntry: false,
    });
    const lookupSpecialization = program.symbols.find((symbol) =>
      symbol.name.startsWith("Avl.lookup$"),
    );
    assert.ok(lookupSpecialization, "expected specialized Avl.lookup symbol");
    assert.match(lookupSpecialization.name, /\$lteKey=Prelude\.lteListU8\$/);
    assert.match(lookupSpecialization.name, /\$K=/);
    assert.match(lookupSpecialization.name, /\$V=/);
    assert.doesNotMatch(lookupSpecialization.name, /\$\$/);

    // Should compile cleanly through MiniCore -> ANF -> Block validation.
    // Before the type-arg substitution fix, this throws
    // MiniCoreBlockValidationError "expected data#1<u8>, got K".
    compileTripSourceToLlvm(PROBE_SOURCE, {
      entryModule: "Probe",
      moduleSources,
      emitMainWrapper: true,
    });
  });
});
