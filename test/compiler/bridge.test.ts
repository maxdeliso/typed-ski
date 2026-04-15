import assert from "node:assert/strict";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { fromTopoDagWire } from "../../lib/ski/topoDagWire.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { describe, it } from "../util/test_shim.ts";
import { readFile } from "node:fs/promises";
import {
  closeBatchThanatosSessions,
  passthroughEvaluator,
  thanatosAvailable,
  withBatchThanatosSession,
} from "../thanatosHarness.ts";

const LEXER_SOURCE_FILE = new URL(
  "../../lib/compiler/lexer.trip",
  import.meta.url,
);
const PARSER_SOURCE_FILE = new URL(
  "../../lib/compiler/parser.trip",
  import.meta.url,
);
const CORE_SOURCE_FILE = new URL(
  "../../lib/compiler/core.trip",
  import.meta.url,
);
const DATA_ENV_SOURCE_FILE = new URL(
  "../../lib/compiler/dataEnv.trip",
  import.meta.url,
);
const UNPARSE_SOURCE_FILE = new URL(
  "../../lib/compiler/unparse.trip",
  import.meta.url,
);
const LOWERING_SOURCE_FILE = new URL(
  "../../lib/compiler/lowering.trip",
  import.meta.url,
);
const CORE_TO_LOWER_SOURCE_FILE = new URL(
  "../../lib/compiler/coreToLower.trip",
  import.meta.url,
);
const BRIDGE_SOURCE_FILE = new URL(
  "../../lib/compiler/bridge.trip",
  import.meta.url,
);
const AVL_SOURCE_FILE = new URL("../../lib/avl.trip", import.meta.url);
const BIN_SOURCE_FILE = new URL("../../lib/bin.trip", import.meta.url);
const NAT_SOURCE_FILE = new URL("../../lib/nat.trip", import.meta.url);

interface BridgeModules {
  prelude: TripCObject;
  lexer: TripCObject;
  parser: TripCObject;
  core: TripCObject;
  dataEnv: TripCObject;
  unparse: TripCObject;
  lowering: TripCObject;
  coreToLower: TripCObject;
  bridge: TripCObject;
  avl: TripCObject;
  bin: TripCObject;
  nat: TripCObject;
}

let bridgeModulesPromise: Promise<BridgeModules> | null = null;

function makeCheckedLengthOverflowHarness(): string {
  return `module Test
import Prelude Bool
import Prelude true
import Prelude false
import Prelude Result
import Prelude Ok
import Prelude Err
import Prelude List
import Prelude U8
import Prelude nil
import Prelude cons
import Bridge checkedLengthU8

export main

poly main =
  match (checkedLengthU8 [U8] (cons [U8] #u8(0) (nil [U8])) #u8(255)) [Bool] {
    | Err e => true
    | Ok total => false
  }
`;
}

async function getBridgeModules(): Promise<BridgeModules> {
  if (!bridgeModulesPromise) {
    bridgeModulesPromise = (async () => {
      const [
        prelude,
        lexer,
        parser,
        core,
        dataEnv,
        unparse,
        lowering,
        coreToLower,
        bridge,
        avl,
        bin,
        nat,
      ] = await Promise.all([
        getPreludeObject(),
        loadTripModuleObject(LEXER_SOURCE_FILE),
        loadTripModuleObject(PARSER_SOURCE_FILE),
        loadTripModuleObject(CORE_SOURCE_FILE),
        loadTripModuleObject(DATA_ENV_SOURCE_FILE),
        loadTripModuleObject(UNPARSE_SOURCE_FILE),
        loadTripModuleObject(LOWERING_SOURCE_FILE),
        loadTripModuleObject(CORE_TO_LOWER_SOURCE_FILE),
        loadTripModuleObject(BRIDGE_SOURCE_FILE),
        loadTripModuleObject(AVL_SOURCE_FILE),
        loadTripModuleObject(BIN_SOURCE_FILE),
        loadTripModuleObject(NAT_SOURCE_FILE),
      ]);

      return {
        prelude,
        lexer,
        parser,
        core,
        dataEnv,
        unparse,
        lowering,
        coreToLower,
        bridge,
        avl,
        bin,
        nat,
      };
    })();
  }
  return await bridgeModulesPromise;
}

async function runBridgeHarness(source: string): Promise<boolean> {
  const modules = await getBridgeModules();
  const testObject = compileToObjectFile(source, {
    importedModules: [
      modules.prelude,
      modules.lexer,
      modules.parser,
      modules.avl,
      modules.lowering,
      modules.bridge,
    ],
  });
  const linked = linkModules([
    { name: "Prelude", object: modules.prelude },
    { name: "Bin", object: modules.bin },
    { name: "Nat", object: modules.nat },
    { name: "Avl", object: modules.avl },
    { name: "Lexer", object: modules.lexer },
    { name: "Parser", object: modules.parser },
    { name: "Core", object: modules.core },
    { name: "DataEnv", object: modules.dataEnv },
    { name: "Unparse", object: modules.unparse },
    { name: "Lowering", object: modules.lowering },
    { name: "CoreToLower", object: modules.coreToLower },
    { name: "Bridge", object: modules.bridge },
    { name: "Test", object: testObject },
  ]);
  const expr = parseSKI(linked);
  return await withBatchThanatosSession(async (session) => {
    const resultDag = await session.reduceExpr(expr);
    const resultExpr = fromTopoDagWire(resultDag);
    return await UnChurchBoolean(resultExpr, passthroughEvaluator);
  });
}

it("Bridge recursion lowering uses explicit Z expansion helpers", async () => {
  const source = await readFile(BRIDGE_SOURCE_FILE, "utf-8");

  assert.ok(source.includes("poly zLower"));
  assert.ok(source.includes("poly applyFixpoint"));
  assert.ok(source.includes("L_App zLower (L_Lam body)"));
  assert.ok(source.includes("applyFixpoint (coreToLower"));
  assert.ok(!source.includes("#u8(89)"));
  assert.ok(source.includes('eqListU8 name "."'));
  assert.ok(source.includes("Some [Lower] (L_Native T_WriteOne)"));
  assert.ok(source.includes('eqListU8 name ","'));
  assert.ok(source.includes("Some [Lower] (L_Native T_ReadOne)"));
  assert.ok(source.includes('eqListU8 name "subU8"'));
  assert.ok(source.includes("Some [Lower] (L_Native T_SubU8)"));
  assert.ok(source.includes("poly unboundNameError"));
  assert.ok(source.includes("poly buildBinLiteralCore"));
  assert.ok(source.includes("poly ctorCountOverflowError"));
  assert.ok(source.includes("poly rec checkedLengthU8"));
  assert.ok(
    source.includes("Ok [List U8] [Core] (Cr_Match coreScrut coreArms)"),
  );

  const bridgeObject = await loadTripModuleObject(BRIDGE_SOURCE_FILE);
  assert.ok("zLower" in bridgeObject.definitions);
  assert.ok("applyFixpoint" in bridgeObject.definitions);
  assert.ok("resolveNativeName" in bridgeObject.definitions);
  assert.ok("unboundNameError" in bridgeObject.definitions);
  assert.ok("buildBinLiteralCore" in bridgeObject.definitions);
  assert.ok("elaborateProgram" in bridgeObject.definitions);
});

it(
  "Bridge rejects data declarations with too many constructors",
  {
    skip: !thanatosAvailable(),
  },
  async () => {
    try {
      const source = await readFile(BRIDGE_SOURCE_FILE, "utf-8");
      assert.ok(
        source.includes("checkedLengthU8 [Pair (List U8) U8] ctors #u8(0)"),
        "Expected D_Data elaboration to use checkedLengthU8 before populating the data environment",
      );
      const ok = await runBridgeHarness(makeCheckedLengthOverflowHarness());
      assert.strictEqual(
        ok,
        true,
        "Expected checkedLengthU8 to reject constructor-count overflow at #u8(255)",
      );
    } finally {
      await closeBatchThanatosSessions();
    }
  },
);
