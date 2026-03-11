import { assert } from "chai";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

const BRIDGE_SOURCE_FILE = new URL(
  "../../lib/compiler/bridge.trip",
  import.meta.url,
);

Deno.test("Bridge recursion lowering uses explicit Z expansion helpers", async () => {
  const source = await Deno.readTextFile(BRIDGE_SOURCE_FILE);

  assert.include(source, "poly zLower");
  assert.include(source, "poly applyFixpoint");
  assert.include(source, "L_App zLower (L_Lam body)");
  assert.include(source, "applyFixpoint lowered");
  assert.notInclude(source, "#u8(89)");
  assert.include(source, 'eqListU8 name "."');
  assert.include(source, "Some [Lower] (L_Native T_WriteOne)");
  assert.include(source, 'eqListU8 name ","');
  assert.include(source, "Some [Lower] (L_Native T_ReadOne)");
  assert.include(source, "poly unboundNameError");
  assert.include(source, "Err [List U8] [Lower] (unboundNameError name)");
  assert.include(source, "poly buildBinLiteral");
  assert.include(
    source,
    'Err [List U8] [Lower] "Match lowering requires constructor-aware elaboration"',
  );

  const bridgeObject = await loadTripModuleObject(BRIDGE_SOURCE_FILE);
  assert.property(bridgeObject.definitions, "zLower");
  assert.property(bridgeObject.definitions, "applyFixpoint");
  assert.property(bridgeObject.definitions, "resolveNativeName");
  assert.property(bridgeObject.definitions, "unboundNameError");
  assert.property(bridgeObject.definitions, "buildBinLiteral");
  assert.property(bridgeObject.definitions, "elaborateProgram");
});
