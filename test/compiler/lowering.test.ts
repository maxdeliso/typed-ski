/**
 * Compiler tests that validate lowering (TripLang → SKI) behavior.
 */

import { assert } from "chai";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";

Deno.test("naked character literal 'x' compiles to U8 after lower", async () => {
  const source = `module Test
export main
poly main = 'x'
`;
  const obj = compileToObjectFile(source);
  const prelude = await getPreludeObject();
  const skiStr = linkModules([
    { name: "Prelude", object: prelude },
    { name: "Test", object: obj },
  ]).expression;
  assert.equal(skiStr.trim(), "#u8(120)");
});

Deno.test("numeric literal 255 vs 256: 255 uses U8, 256 uses number pipeline", async () => {
  const prelude = await getPreludeObject();

  const source255 = `module Test
export main
poly main = 255
`;
  const obj255 = compileToObjectFile(source255);
  const rep255 = linkModules([
    { name: "Prelude", object: prelude },
    { name: "Test", object: obj255 },
  ]).expression;
  console.log("255 rep:", rep255.trim());

  const source256 = `module Test
export main
poly main = 256
`;
  const obj256 = compileToObjectFile(source256);
  const rep256 = linkModules([
    { name: "Prelude", object: prelude },
    { name: "Test", object: obj256 },
  ]).expression;
  console.log("256 rep:", rep256.trim());

  assert.equal(rep255.trim(), "#u8(255)", "255 should lower to U8");
  assert.notEqual(rep256.trim(), "#u8(256)", "256 should not lower to U8");
});
