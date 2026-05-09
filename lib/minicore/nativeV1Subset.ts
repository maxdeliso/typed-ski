import type {
  ConstructorDef,
  Expr,
  FunctionDef,
  Program,
  SymbolDef,
} from "./ast.ts";
import {
  miniTypeToString,
  type MiniCoreMetadata,
  type MiniType,
} from "./metadata.ts";

export class NativeV1SubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeV1SubsetError";
  }
}

export interface NativeV1SubsetValidationOptions {
  /**
   * The first native bootstrap deliberately has no closure representation. This
   * option exists only for narrowly-scoped experiments; production bootstrap
   * validation should keep the default `true`.
   */
  rejectRuntimeFunctionTypes?: boolean;
}

export function validateNativeV1Subset(
  program: Program,
  options: NativeV1SubsetValidationOptions = {},
): void {
  const metadata = program.metadata;
  if (!metadata) {
    throw new NativeV1SubsetError(
      "Native-v1 subset validation requires MiniCore metadata",
    );
  }

  const rejectRuntimeFunctionTypes = options.rejectRuntimeFunctionTypes ?? true;

  for (const symbol of program.symbols) {
    switch (symbol.kind) {
      case "function":
        validateFunction(symbol, metadata, rejectRuntimeFunctionTypes);
        break;
      case "constructor":
        validateConstructor(symbol, metadata, rejectRuntimeFunctionTypes);
        break;
      case "primitive":
        break;
    }
  }
}

function validateFunction(
  fn: FunctionDef,
  metadata: MiniCoreMetadata,
  rejectRuntimeFunctionTypes: boolean,
): void {
  const info = metadata.functions.get(fn.id);
  if (!info) {
    throw new NativeV1SubsetError(
      `Native-v1 missing function metadata for ${fn.name}`,
    );
  }

  if (rejectRuntimeFunctionTypes) {
    info.paramTypes.forEach((type, index) =>
      rejectFunctionType(type, `runtime parameter ${index} of ${fn.name}`),
    );
    rejectFunctionType(info.resultType, `runtime result of ${fn.name}`);

    const localTypes = metadata.localTypesByFunction.get(fn.id);
    if (localTypes) {
      for (const [local, type] of localTypes) {
        rejectFunctionType(type, `local %${local} of ${fn.name}`);
      }
    }
  }

  validateExpr(fn.body, fn, metadata, rejectRuntimeFunctionTypes);
}

function validateConstructor(
  ctor: ConstructorDef,
  metadata: MiniCoreMetadata,
  rejectRuntimeFunctionTypes: boolean,
): void {
  if (!rejectRuntimeFunctionTypes) return;
  const info = metadata.constructors.get(ctor.id);
  if (!info) {
    throw new NativeV1SubsetError(
      `Native-v1 missing constructor metadata for ${ctor.name}`,
    );
  }
  info.fieldTypes.forEach((type, index) =>
    rejectFunctionType(type, `field ${index} of constructor ${ctor.name}`),
  );
}

function validateExpr(
  expr: Expr,
  fn: FunctionDef,
  metadata: MiniCoreMetadata,
  rejectRuntimeFunctionTypes: boolean,
): void {
  switch (expr.kind) {
    case "var":
    case "lit":
      return;
    case "call":
    case "prim":
    case "runtimeCall":
      expr.args.forEach((arg) =>
        validateExpr(arg, fn, metadata, rejectRuntimeFunctionTypes),
      );
      return;
    case "con":
      validateKnownConstructor(expr.target, fn, metadata);
      expr.fields.forEach((field) =>
        validateExpr(field, fn, metadata, rejectRuntimeFunctionTypes),
      );
      return;
    case "case":
      validateExpr(expr.scrutinee, fn, metadata, rejectRuntimeFunctionTypes);
      for (const alt of expr.alts) {
        validateKnownConstructor(alt.constructor, fn, metadata);
        validateExpr(alt.body, fn, metadata, rejectRuntimeFunctionTypes);
      }
      return;
    case "let":
      for (const binding of expr.bindings) {
        validateExpr(binding.value, fn, metadata, rejectRuntimeFunctionTypes);
      }
      validateExpr(expr.body, fn, metadata, rejectRuntimeFunctionTypes);
      return;
  }
}

function validateKnownConstructor(
  symbol: number,
  fn: FunctionDef,
  metadata: MiniCoreMetadata,
): void {
  if (!metadata.constructors.has(symbol)) {
    throw new NativeV1SubsetError(
      `Native-v1 function ${fn.name} references unknown constructor symbol ${symbol}`,
    );
  }
}

function rejectFunctionType(type: MiniType, context: string): void {
  if (containsFunctionType(type)) {
    throw new NativeV1SubsetError(
      `Native-v1 unsupported function value type in ${context}: ${miniTypeToString(
        type,
      )}`,
    );
  }
}

function containsFunctionType(type: MiniType): boolean {
  switch (type.kind) {
    case "fn":
    case "forall":
      return true;
    case "data":
      return type.args.some(containsFunctionType);
    case "nat":
    case "u8":
    case "bool":
    case "unit":
    case "unknown":
    case "var":
      return false;
  }
}

export function isNativeV1RuntimeSymbol(symbol: SymbolDef): boolean {
  return symbol.kind === "function" || symbol.kind === "constructor";
}
