import { it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { createThanatosEvaluator, thanatosAvailable } from "../../lib/index.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

it(
  "bootstrapped Parser.parseType correctly parses a complex type",
  { skip: !thanatosAvailable() },
  async () => {
    const preludeObject = await getPreludeObject();
    const natObject = await getNatObject();
    const lexerObject = await loadTripModuleObject(
      join(workspaceRoot, "lib", "compiler", "lexer.trip"),
    );
    const parserObject = await loadTripModuleObject(
      join(workspaceRoot, "lib", "compiler", "parser.trip"),
    );
    const binObject = await loadTripModuleObject(
      join(workspaceRoot, "lib", "bin.trip"),
    );
    const testObject = await loadTripModuleObject(
      join(workspaceRoot, "test", "compiler", "inputs", "testParseType.trip"),
    );

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
      { name: "Bin", object: binObject },
      { name: "Lexer", object: lexerObject },
      { name: "Parser", object: parserObject },
      { name: "Test", object: testObject },
    ]);

    const skiExpr = parseSKI(skiExpression);
    const evaluator = await createThanatosEvaluator();
    try {
      const evaluated = await evaluator.reduce(skiExpr);
      const result = await UnChurchBoolean(evaluated, evaluator);
      assert.strictEqual(result, true, "testParseType.trip should return true");
    } finally {
      await evaluator.terminate();
    }
  },
);
