import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export type AvlCase = {
  name: string;
  moduleName: string;
  loadSource: () => Promise<string>;
  expected: bigint;
};

export type AvlBuiltinObjects = {
  preludeObject: TripCObject;
  binObject: TripCObject;
  natObject: TripCObject;
  avlObject: TripCObject;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = join(__dirname, "inputs", "avl");

function loadInput(fileName: string): Promise<string> {
  return readFile(join(INPUT_DIR, fileName), "utf-8");
}

function buildAvlBinBoolProbeSource(mainExpression: string): string {
  return `module AvlBinBoolProbe

import Nat Nat
import Nat zero
import Nat succ
import Prelude Bool
import Prelude true
import Prelude false
import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude Maybe
import Prelude Some
import Prelude None
import Bin lteBin
import Avl Avl
import Avl empty
import Avl insert
import Avl lookup
import Avl size

export main

poly boolToNat = \\b : Bool => b [Nat] (succ zero) zero

poly maybeBoolToNat = \\m : Maybe Bool =>
  match m [Nat] {
    | None => zero
    | Some b => boolToNat b
  }

poly main =
  let k1 = B1 BZ in
  let k2 = B0 (B1 BZ) in
  let k3 = B1 (B1 BZ) in
  let t0 = empty [Bin] [Bool] in
  let t1 = insert [Bin] [Bool] lteBin k2 false t0 in
  let t2 = insert [Bin] [Bool] lteBin k1 true t1 in
  let t3 = insert [Bin] [Bool] lteBin k3 true t2 in
  let t4 = insert [Bin] [Bool] lteBin k2 true t3 in
  ${mainExpression}
`;
}

export const AVL_CASES: AvlCase[] = [
  {
    name: "AvlNatTreeTest",
    moduleName: "AvlNatTreeTest",
    loadSource: () => loadInput("AvlNatTreeTest.trip"),
    expected: 12n,
  },
  {
    name: "AvlBinBoolTreeTest beforeReplace",
    moduleName: "AvlBinBoolProbe",
    loadSource: () =>
      Promise.resolve(
        buildAvlBinBoolProbeSource(
          "maybeBoolToNat (lookup [Bin] [Bool] lteBin k2 t3)",
        ),
      ),
    expected: 0n,
  },
  {
    name: "AvlBinBoolTreeTest afterReplace",
    moduleName: "AvlBinBoolProbe",
    loadSource: () =>
      Promise.resolve(
        buildAvlBinBoolProbeSource(
          "maybeBoolToNat (lookup [Bin] [Bool] lteBin k2 t4)",
        ),
      ),
    expected: 1n,
  },
  {
    name: "AvlBinBoolTreeTest gotK1",
    moduleName: "AvlBinBoolProbe",
    loadSource: () =>
      Promise.resolve(
        buildAvlBinBoolProbeSource(
          "maybeBoolToNat (lookup [Bin] [Bool] lteBin k1 t4)",
        ),
      ),
    expected: 1n,
  },
  {
    name: "AvlBinBoolTreeTest missing",
    moduleName: "AvlBinBoolProbe",
    loadSource: () =>
      Promise.resolve(
        buildAvlBinBoolProbeSource(
          "maybeBoolToNat (lookup [Bin] [Bool] lteBin BZ t4)",
        ),
      ),
    expected: 0n,
  },
  {
    name: "AvlBinBoolTreeTest sizeBefore",
    moduleName: "AvlBinBoolProbe",
    loadSource: () =>
      Promise.resolve(buildAvlBinBoolProbeSource("size [Bin] [Bool] t3")),
    expected: 3n,
  },
  {
    name: "AvlBinBoolTreeTest sizeAfter",
    moduleName: "AvlBinBoolProbe",
    loadSource: () =>
      Promise.resolve(buildAvlBinBoolProbeSource("size [Bin] [Bool] t4")),
    expected: 4n,
  },
  {
    name: "AvlInsertTraversalTest",
    moduleName: "AvlInsertTraversalTest",
    loadSource: () => loadInput("AvlInsertTraversalTest.trip"),
    expected: 321n,
  },
  {
    name: "AvlDeleteTraversalTest",
    moduleName: "AvlDeleteTraversalTest",
    loadSource: () => loadInput("AvlDeleteTraversalTest.trip"),
    expected: 36n,
  },
];

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
