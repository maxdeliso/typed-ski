import {
  compileToObjectFileString,
  deserializeTripCObject,
} from "../lib/compiler/index.ts";
import { getBinObject } from "../lib/bin.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { getNatObject } from "../lib/nat.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import type { TripCObject } from "../lib/compiler/objectFile.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { getAvlObject } from "./util/avl.ts";
export { AVL_CASES, type AvlCase } from "./avlCases.ts";

export type AvlBuiltinObjects = {
  preludeObject: TripCObject;
  binObject: TripCObject;
  natObject: TripCObject;
  avlObject: TripCObject;
};

let builtinObjectsPromise: Promise<AvlBuiltinObjects> | undefined;

export function getAvlBuiltinObjectsCached(): Promise<AvlBuiltinObjects> {
  return (builtinObjectsPromise ??= Promise.all([
    getPreludeObject(),
    getBinObject(),
    getNatObject(),
    getAvlObject(),
  ]).then(([preludeObject, binObject, natObject, avlObject]) => ({
    preludeObject,
    binObject,
    natObject,
    avlObject,
  })));
}

export function linkAvlModulesWithBuiltins(
  moduleName: string,
  testObject: TripCObject,
  builtins: AvlBuiltinObjects,
): string {
  return linkModules([
    { name: "Prelude", object: builtins.preludeObject },
    { name: "Bin", object: builtins.binObject },
    { name: "Nat", object: builtins.natObject },
    { name: "Avl", object: builtins.avlObject },
    { name: moduleName, object: testObject },
  ]);
}

export async function buildAvlTestExpression(
  source: string,
  moduleName: string,
): Promise<SKIExpression> {
  const builtins = await getAvlBuiltinObjectsCached();
  const serialized = compileToObjectFileString(source);
  const testObject = deserializeTripCObject(serialized);
  const skiExpression = linkAvlModulesWithBuiltins(
    moduleName,
    testObject,
    builtins,
  );
  return parseSKI(skiExpression);
}
