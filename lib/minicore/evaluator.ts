import type {
  ConstructorDef,
  Expr,
  LocalId,
  PrimitiveDef,
  Program,
  SymbolId,
  Value,
} from "./ast.ts";

export interface MiniCoreTelemetry {
  functionEntries: number;
  caseDispatches: number;
  constructorAllocs: number;
  primitiveOps: number;
  maxRecursionDepth: number;
}

export interface MiniCoreEvalResult {
  value: Value;
  telemetry: MiniCoreTelemetry;
}

type Env = Value[];

function emptyTelemetry(): MiniCoreTelemetry {
  return {
    functionEntries: 0,
    caseDispatches: 0,
    constructorAllocs: 0,
    primitiveOps: 0,
    maxRecursionDepth: 0,
  };
}

function requireValue(env: Env, id: LocalId): Value {
  const value = env[id];
  if (value === undefined) {
    throw new Error(`MiniCore local ${id} is unbound`);
  }
  return value;
}

function requireNat(value: Value): bigint {
  if (value.kind !== "lit" || value.value.kind !== "nat") {
    throw new Error("Expected nat literal");
  }
  return value.value.value;
}

function requireU8(value: Value): number {
  if (value.kind !== "lit" || value.value.kind !== "u8") {
    throw new Error("Expected u8 literal");
  }
  return value.value.value;
}

function requireConstructor(program: Program, name: string): ConstructorDef {
  const id = program.symbolsByName.get(name);
  if (id === undefined) {
    throw new Error(`Missing constructor symbol ${name}`);
  }
  const def = program.symbols[id];
  if (!def || def.kind !== "constructor") {
    throw new Error(`Symbol ${name} is not a constructor`);
  }
  return def;
}

function boolValue(program: Program, value: boolean): Value {
  return {
    kind: "con",
    tag: requireConstructor(program, value ? "Prelude.true" : "Prelude.false")
      .id,
    fields: [],
  };
}

function isBoolValue(
  program: Program,
  value: Value,
  expected: boolean,
): boolean {
  return (
    value.kind === "con" &&
    value.tag ===
      requireConstructor(program, expected ? "Prelude.true" : "Prelude.false")
        .id
  );
}

function natValue(value: bigint): Value {
  return { kind: "lit", value: { kind: "nat", value } };
}

function u8Value(value: number): Value {
  return { kind: "lit", value: { kind: "u8", value: value & 0xff } };
}

function binToBigInt(program: Program, value: Value): bigint {
  if (value.kind !== "con") {
    throw new Error("Expected Bin constructor");
  }

  const bz = requireConstructor(program, "Prelude.BZ").id;
  const b0 = requireConstructor(program, "Prelude.B0").id;
  const b1 = requireConstructor(program, "Prelude.B1").id;

  if (value.tag === bz) {
    return 0n;
  }
  if (value.tag === b0) {
    return 2n * binToBigInt(program, value.fields[0]!);
  }
  if (value.tag === b1) {
    return 2n * binToBigInt(program, value.fields[0]!) + 1n;
  }

  throw new Error("Expected Bin constructor");
}

function executePrimitive(
  primitive: PrimitiveDef,
  args: Value[],
  program: Program,
): Value {
  switch (primitive.name) {
    case "Nat.succ":
      return natValue(requireNat(args[0]!) + 1n);
    case "Nat.add":
      return natValue(requireNat(args[0]!) + requireNat(args[1]!));
    case "Nat.mul":
      return natValue(requireNat(args[0]!) * requireNat(args[1]!));
    case "Nat.lte":
      return boolValue(program, requireNat(args[0]!) <= requireNat(args[1]!));
    case "Nat.fromBin":
      return natValue(binToBigInt(program, args[0]!));
    case "Bin.lteBin":
      return boolValue(
        program,
        binToBigInt(program, args[0]!) <= binToBigInt(program, args[1]!),
      );
    case "Prelude.not":
      return boolValue(program, isBoolValue(program, args[0]!, false));
    case "Prelude.eqU8":
      return boolValue(program, requireU8(args[0]!) === requireU8(args[1]!));
    case "Prelude.ltU8":
      return boolValue(program, requireU8(args[0]!) < requireU8(args[1]!));
    case "Prelude.addU8":
      return u8Value(requireU8(args[0]!) + requireU8(args[1]!));
    case "Prelude.subU8":
      return u8Value(requireU8(args[0]!) - requireU8(args[1]!));
    case "Prelude.divU8": {
      const rhs = requireU8(args[1]!);
      return u8Value(rhs === 0 ? 0 : Math.trunc(requireU8(args[0]!) / rhs));
    }
    case "Prelude.modU8": {
      const rhs = requireU8(args[1]!);
      return u8Value(rhs === 0 ? 0 : requireU8(args[0]!) % rhs);
    }
    case "Prelude.error":
      throw new Error("MiniCore evaluated Prelude.error");
    default:
      throw new Error(`Unknown MiniCore primitive ${primitive.name}`);
  }
}

/**
 * MiniCore v0 is a strict backend.
 * Constructor fields, function arguments, and primitive arguments are all
 * evaluated eagerly before the operation (allocation, call, or primitive)
 * is performed.
 *
 * This differs from the lazy/encoded SKI backend but is suitable for
 * performance-oriented programs that fit within this strict subset.
 */
function evalExpr(
  expr: Expr,
  env: Env,
  program: Program,
  telemetry: MiniCoreTelemetry,
  depth: number,
): Value {
  switch (expr.kind) {
    case "var":
      return requireValue(env, expr.id);
    case "lit":
      return { kind: "lit", value: expr.value };
    case "con": {
      const def = program.symbols[expr.target];
      if (!def || def.kind !== "constructor") {
        throw new Error(`MiniCore symbol ${expr.target} is not a constructor`);
      }
      if (expr.fields.length !== def.arity) {
        throw new Error(
          `${def.name} expects ${def.arity} field(s), got ${expr.fields.length}`,
        );
      }
      telemetry.constructorAllocs++;
      return {
        kind: "con",
        tag: expr.target,
        fields: expr.fields.map((field) =>
          evalExpr(field, env, program, telemetry, depth),
        ),
      };
    }
    case "call": {
      const def = program.symbols[expr.target];
      if (!def || def.kind !== "function") {
        throw new Error(`MiniCore symbol ${expr.target} is not a function`);
      }
      if (expr.args.length !== def.arity) {
        throw new Error(
          `${def.name} expects ${def.arity} argument(s), got ${expr.args.length}`,
        );
      }
      telemetry.functionEntries++;
      const nextDepth = depth + 1;
      telemetry.maxRecursionDepth = Math.max(
        telemetry.maxRecursionDepth,
        nextDepth,
      );
      const nextEnv: Env = [];
      for (let i = 0; i < def.params.length; i++) {
        nextEnv[def.params[i]!] = evalExpr(
          expr.args[i]!,
          env,
          program,
          telemetry,
          depth,
        );
      }
      return evalExpr(def.body, nextEnv, program, telemetry, nextDepth);
    }
    case "prim": {
      const def = program.symbols[expr.target];
      if (!def || def.kind !== "primitive") {
        throw new Error(`MiniCore symbol ${expr.target} is not a primitive`);
      }
      if (expr.args.length !== def.arity) {
        throw new Error(
          `${def.name} expects ${def.arity} argument(s), got ${expr.args.length}`,
        );
      }
      telemetry.primitiveOps++;
      const args = expr.args.map((arg) =>
        evalExpr(arg, env, program, telemetry, depth),
      );
      return executePrimitive(def, args, program);
    }
    case "case": {
      const scrutinee = evalExpr(
        expr.scrutinee,
        env,
        program,
        telemetry,
        depth,
      );
      if (scrutinee.kind !== "con") {
        throw new Error("MiniCore case scrutinee is not a constructor value");
      }
      telemetry.caseDispatches++;
      const alt = expr.alts.find(
        (candidate) => candidate.constructor === scrutinee.tag,
      );
      if (!alt) {
        const def = program.symbols[scrutinee.tag];
        const name = def?.name ?? String(scrutinee.tag);
        throw new Error(`MiniCore non-exhaustive case for ${name}`);
      }
      if (alt.binders.length !== scrutinee.fields.length) {
        throw new Error(
          "MiniCore case binder count does not match constructor arity",
        );
      }
      const nextEnv = env.slice();
      for (let i = 0; i < alt.binders.length; i++) {
        nextEnv[alt.binders[i]!] = scrutinee.fields[i]!;
      }
      return evalExpr(alt.body, nextEnv, program, telemetry, depth);
    }
    case "let": {
      const nextEnv = env.slice();
      for (const binding of expr.bindings) {
        nextEnv[binding.id] = evalExpr(
          binding.value,
          nextEnv,
          program,
          telemetry,
          depth,
        );
      }
      return evalExpr(expr.body, nextEnv, program, telemetry, depth);
    }
  }
}

export function evaluateMiniCore(program: Program): MiniCoreEvalResult {
  const telemetry = emptyTelemetry();
  const value = evalExpr(
    { kind: "call", target: program.entry, args: [] },
    [],
    program,
    telemetry,
    0,
  );
  return { value, telemetry };
}

export function valueToNat(value: Value): bigint {
  if (value.kind !== "lit" || value.value.kind !== "nat") {
    throw new Error("Expected MiniCore Nat literal result");
  }
  return value.value.value;
}
