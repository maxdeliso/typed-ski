import { parseNatLiteralIdentifier } from "../consts/natNames.ts";
import type {
  DataDefinition,
  PolyDefinition,
  TripLangTerm,
} from "../meta/trip.ts";
import { parseTripLang } from "../parser/tripLang.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { BaseType } from "../types/types.ts";
import type {
  ConstructorDef,
  Expr,
  FunctionDef,
  LocalId,
  PrimitiveClass,
  PrimitiveDef,
  Program,
  SymbolDef,
  SymbolId,
} from "./ast.ts";
import {
  emptyMiniCoreMetadata,
  miniTypeEquals,
  miniTypeFromBaseType,
  miniTypeToString,
  miniTypeUnify,
  substituteMiniType,
  type MiniCoreMetadata,
  type MiniType,
  type TypeId,
} from "./metadata.ts";
import { typeOfMiniCoreExpr } from "./typeOf.ts";
import { validateMiniCoreProgram } from "./validator.ts";

export interface MiniCoreModuleSource {
  name: string;
  source: string;
}

export interface CompileMiniCoreModulesOptions {
  requireNullaryEntry?: boolean;
}

export class MiniCoreCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniCoreCompileError";
  }
}

interface SourceModule {
  name: string;
  imports: Map<string, string>;
  exports: Set<string>;
  definitions: Map<string, TripLangTerm>;
  dataDefinitions: DataDefinition[];
}

type FunctionState = "declared" | "compiling" | "compiled";

interface LoweringContext {
  moduleName: string;
  locals: Map<string, LocalId>;
  localTypes: Map<LocalId, MiniType>;
  localTypesByName: Map<string, MiniType>;
  functionLocals: Map<string, SymbolId>;
  nextLocalId: number;
  fnSymbol: SymbolId;
}

type StaticBinding = {
  paramName: string;
  symbol: SymbolId;
};

interface Specialization {
  symbolName: string;
  staticBindings: StaticBinding[];
}

const MINI_PRIMITIVES: Array<[string, number, PrimitiveClass]> = [
  ["Nat.succ", 1, "numeric"],
  ["Nat.add", 2, "numeric"],
  ["Nat.mul", 2, "numeric"],
  ["Nat.lte", 2, "numeric"],
  ["Prelude.not", 1, "boolean"],
  ["Prelude.eqU8", 2, "numeric"],
  ["Prelude.ltU8", 2, "numeric"],
  ["Prelude.addU8", 2, "numeric"],
  ["Prelude.subU8", 2, "numeric"],
  ["Prelude.divU8", 2, "numeric"],
  ["Prelude.modU8", 2, "numeric"],
  ["Prelude.error", 0, "library-accelerator"],
];

function splitQualifiedName(qName: string): [string, string] {
  const dot = qName.lastIndexOf(".");
  if (dot < 0) {
    throw new MiniCoreCompileError(`Invalid qualified name ${qName}`);
  }
  return [qName.slice(0, dot), qName.slice(dot + 1)];
}

function requireTermDefinition(
  module: SourceModule,
  name: string,
): TripLangTerm {
  const def = module.definitions.get(name);
  if (!def) {
    throw new MiniCoreCompileError(`Missing definition ${module.name}.${name}`);
  }
  return def;
}

function moduleNameOf(terms: TripLangTerm[]): string {
  const moduleTerm = terms.find((term) => term.kind === "module");
  if (!moduleTerm) {
    throw new MiniCoreCompileError("MiniCore module source has no module term");
  }
  return moduleTerm.name;
}

function parseSourceModule(input: MiniCoreModuleSource): SourceModule {
  const program = parseTripLang(input.source);
  const declaredName = moduleNameOf(program.terms);
  if (declaredName !== input.name) {
    throw new MiniCoreCompileError(
      `MiniCore module source name mismatch: expected ${input.name}, got ${declaredName}`,
    );
  }

  const imports = new Map<string, string>();
  const exports = new Set<string>();
  const definitions = new Map<string, TripLangTerm>();
  const dataDefinitions: DataDefinition[] = [];

  for (const term of program.terms) {
    switch (term.kind) {
      case "import":
        if (imports.has(term.ref)) {
          throw new MiniCoreCompileError(
            `Duplicate import ${term.ref} in module ${declaredName}`,
          );
        }
        imports.set(term.ref, `${term.name}.${term.ref}`);
        break;

      case "export":
        exports.add(term.name);
        break;
      case "module":
        break;
      case "data":
        dataDefinitions.push(term);
        definitions.set(term.name, term);
        break;
      default:
        definitions.set(term.name, term);
        break;
    }
  }

  return {
    name: input.name,
    imports,
    exports,
    definitions,
    dataDefinitions,
  };
}

function stripTypeApps(term: SystemFTerm): {
  term: SystemFTerm;
  args: BaseType[];
  stripped: boolean;
} {
  let current = term;
  const args: BaseType[] = [];
  let stripped = false;
  while (current.kind === "systemF-type-app") {
    args.unshift(current.typeArg);
    current = current.term;
    stripped = true;
  }
  return { term: current, args, stripped };
}

function stripTypeAbs(term: SystemFTerm): SystemFTerm {
  let current = term;
  while (current.kind === "systemF-type-abs") {
    current = current.body;
  }
  return current;
}

function collectTopLevelParams(term: SystemFTerm): {
  typeParams: string[];
  params: string[];
  paramTypes: BaseType[];
  body: SystemFTerm;
} {
  const typeParams: string[] = [];
  const params: string[] = [];
  const paramTypes: BaseType[] = [];
  let current = term;

  while (
    current.kind === "systemF-type-abs" ||
    current.kind === "systemF-abs"
  ) {
    if (current.kind === "systemF-type-abs") {
      typeParams.push(current.typeVar);
      current = current.body;
    } else {
      params.push(current.name);
      paramTypes.push(current.typeAnnotation);
      current = current.body;
    }
  }

  return { typeParams, params, paramTypes, body: current };
}

function flattenApplication(term: SystemFTerm): {
  head: SystemFTerm;
  args: SystemFTerm[];
} {
  const args: SystemFTerm[] = [];
  let head = term;
  while (head.kind === "non-terminal") {
    args.unshift(head.rgt);
    head = head.lft;
  }
  return { head, args };
}

function applyTermArgs(head: SystemFTerm, args: SystemFTerm[]): SystemFTerm {
  return args.reduce<SystemFTerm>(
    (lft, rgt) => ({ kind: "non-terminal", lft, rgt }),
    head,
  );
}

class MiniCoreBuilder {
  private readonly modules: Map<string, SourceModule>;
  private readonly exportModulesByName = new Map<string, Set<string>>();
  private readonly symbols: SymbolDef[] = [];
  private readonly symbolsByName = new Map<string, SymbolId>();
  private readonly callableSymbolsByQName = new Map<string, SymbolId>();
  private readonly functionStates = new Map<SymbolId, FunctionState>();
  private readonly metadata: MiniCoreMetadata = emptyMiniCoreMetadata();
  private readonly dataTypeByQName = new Map<string, TypeId>();
  private nextTypeId: TypeId = 0;
  private readonly constructorByQName = new Map<string, SymbolId>();
  private readonly constructorAliasByQName = new Map<
    string,
    SymbolId | "ambiguous"
  >();
  private readonly constructorsByLocalName = new Map<string, Set<SymbolId>>();
  private readonly specializedFunctions = new Map<string, SymbolId>();
  private readonly callableParamsCache = new Map<string, Set<string>>();

  constructor(modules: SourceModule[]) {
    this.modules = new Map(modules.map((module) => [module.name, module]));
    for (const module of modules) {
      for (const exportName of module.exports) {
        let exportedBy = this.exportModulesByName.get(exportName);
        if (!exportedBy) {
          exportedBy = new Set<string>();
          this.exportModulesByName.set(exportName, exportedBy);
        }
        exportedBy.add(module.name);
      }
    }
    this.addPseudoConstructors();
    this.addDataConstructors(modules);
    this.addPrimitiveSymbols();
  }

  build(entryQName: string): Program {
    const entry = this.ensureCallable(entryQName);
    this.markExportedSymbols();
    return {
      symbols: this.symbols,
      entry,
      symbolsByName: this.symbolsByName,
      metadata: this.metadata,
    };
  }

  private addSymbol(def: Omit<ConstructorDef, "id">): SymbolId;
  private addSymbol(def: Omit<FunctionDef, "id">): SymbolId;
  private addSymbol(def: Omit<PrimitiveDef, "id">): SymbolId;
  private addSymbol(def: Omit<SymbolDef, "id">): SymbolId {
    const id = this.symbols.length;
    this.symbols.push({ ...def, id } as SymbolDef);
    this.symbolsByName.set(def.name, id);
    return id;
  }

  private addConstructor(
    qName: string,
    localName: string,
    tag: number,
    fieldTypes: MiniType[],
    dataType: TypeId,
  ): SymbolId {
    const existing = this.constructorByQName.get(qName);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.addSymbol({
      kind: "constructor",
      name: qName,
      tag,
      arity: fieldTypes.length,
    });
    const dataDef = this.metadata.dataTypes.get(dataType);
    if (dataDef) {
      dataDef.constructors.push(id);
    }
    this.metadata.constructors.set(id, {
      symbol: id,
      dataType,
      tag,
      fieldTypes,
      resultType: this.resultTypeForDataType(dataType),
    });
    this.constructorByQName.set(qName, id);
    let localSet = this.constructorsByLocalName.get(localName);
    if (!localSet) {
      localSet = new Set();
      this.constructorsByLocalName.set(localName, localSet);
    }
    localSet.add(id);
    return id;
  }

  private addPseudoConstructors(): void {
    const bool = this.addDataType("Prelude.Bool", "Bool", []);
    const list = this.addDataType("Prelude.List", "List", ["A"]);
    const falseConstructor = this.addConstructor(
      "Prelude.false",
      "false",
      0,
      [],
      bool,
    );
    const trueConstructor = this.addConstructor(
      "Prelude.true",
      "true",
      1,
      [],
      bool,
    );
    this.metadata.bool = {
      type: { kind: "bool" },
      dataType: bool,
      trueConstructor,
      falseConstructor,
    };
    this.addConstructor("Prelude.nil", "nil", 0, [], list);
    this.addConstructor(
      "Prelude.cons",
      "cons",
      1,
      [{ kind: "var", name: "A" }, this.resultTypeForDataType(list)],
      list,
    );
  }

  private addDataConstructors(modules: SourceModule[]): void {
    for (const module of modules) {
      for (const dataDef of module.dataDefinitions) {
        this.addDataType(`${module.name}.${dataDef.name}`, dataDef.name, [
          ...dataDef.typeParams,
        ]);
      }
    }

    for (const module of modules) {
      for (const dataDef of module.dataDefinitions) {
        const dataType = this.requireDataType(`${module.name}.${dataDef.name}`);
        dataDef.constructors.forEach((ctor, index) => {
          const qName = `${module.name}.${dataDef.name}.${ctor.name}`;
          const moduleQName = `${module.name}.${ctor.name}`;
          const id = this.addConstructor(
            qName,
            ctor.name,
            index,
            ctor.fields.map((field) =>
              this.miniTypeFromBaseType(field, module.name),
            ),
            dataType,
          );

          const existingAlias = this.constructorAliasByQName.get(moduleQName);
          if (existingAlias === undefined) {
            this.constructorAliasByQName.set(moduleQName, id);
            this.symbolsByName.set(moduleQName, id);
          } else if (existingAlias !== id) {
            this.constructorAliasByQName.set(moduleQName, "ambiguous");
            this.symbolsByName.delete(moduleQName);
          }
        });
      }
    }
  }

  private addDataType(
    qName: string,
    localName: string,
    typeParams: string[],
  ): TypeId {
    const existing = this.dataTypeByQName.get(qName);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.nextTypeId++;
    this.metadata.dataTypes.set(id, {
      id,
      name: qName,
      typeParams,
      constructors: [],
    });
    this.dataTypeByQName.set(qName, id);
    if (!this.dataTypeByQName.has(localName)) {
      this.dataTypeByQName.set(localName, id);
    }
    return id;
  }

  private requireDataType(qName: string): TypeId {
    const id = this.dataTypeByQName.get(qName);
    if (id === undefined) {
      throw new MiniCoreCompileError(`Unknown MiniCore datatype ${qName}`);
    }
    return id;
  }

  private resultTypeForDataType(dataType: TypeId): MiniType {
    const def = this.metadata.dataTypes.get(dataType);
    if (!def) {
      return { kind: "unknown" };
    }
    if (
      this.metadata.bool?.dataType === dataType ||
      def.name === "Prelude.Bool"
    ) {
      return { kind: "bool" };
    }
    return {
      kind: "data",
      id: dataType,
      args: def.typeParams.map((param) => ({ kind: "var", name: param })),
    };
  }

  private miniTypeFromBaseType(type: BaseType, moduleName?: string): MiniType {
    const builder = this;
    return miniTypeFromBaseType(type, (name) => {
      const id = builder.resolveDataTypeName(name, moduleName);
      if (id !== undefined) {
        const def = builder.metadata.dataTypes.get(id);
        return {
          kind: "data",
          id,
          args: def
            ? def.typeParams.map((p) => ({ kind: "var", name: p }))
            : [],
        };
      }
      return id;
    });
  }

  private resolveDataTypeName(
    name: string,
    moduleName?: string,
  ): TypeId | undefined {
    if (moduleName) {
      const local = this.dataTypeByQName.get(`${moduleName}.${name}`);
      if (local !== undefined) {
        return local;
      }
    }
    const global = this.dataTypeByQName.get(name);
    if (global !== undefined) return global;

    // Fallback for core types
    return this.dataTypeByQName.get(`Prelude.${name}`);
  }

  private addPrimitiveSymbols(): void {
    for (const [name, arity, cls] of MINI_PRIMITIVES) {
      const strict = Array.from({ length: arity }, () => true);
      const id = this.addSymbol({
        kind: "primitive",
        name,
        arity,
        strict,
        class: cls,
      });
      const signature = this.primitiveSignature(name, arity);
      this.metadata.primitives.set(id, {
        symbol: id,
        argTypes: signature.args,
        resultType: signature.result,
        strict,
        effects: name === "Prelude.error" ? "trap" : "pure",
      });
      this.callableSymbolsByQName.set(name, id);
      this.functionStates.set(id, "compiled");
    }
  }

  private primitiveSignature(
    name: string,
    arity: number,
  ): { args: MiniType[]; result: MiniType } {
    const nat = { kind: "nat" } as MiniType;
    const u8 = { kind: "u8" } as MiniType;
    const bool = { kind: "bool" } as MiniType;
    switch (name) {
      case "Nat.succ":
        return { args: [nat], result: nat };
      case "Nat.add":
      case "Nat.mul":
        return { args: [nat, nat], result: nat };
      case "Nat.lte":
        return { args: [nat, nat], result: bool };
      case "Prelude.not":
        return { args: [bool], result: bool };
      case "Prelude.eqU8":
      case "Prelude.ltU8":
        return { args: [u8, u8], result: bool };
      case "Prelude.addU8":
      case "Prelude.subU8":
      case "Prelude.divU8":
      case "Prelude.modU8":
        return { args: [u8, u8], result: u8 };
      case "Prelude.error":
        return { args: [], result: { kind: "unknown" } };
      default:
        return {
          args: Array.from({ length: arity }, () => ({ kind: "unknown" })),
          result: { kind: "unknown" },
        };
    }
  }

  private resolveExportedQName(localName: string): string | undefined {
    const modules = [...(this.exportModulesByName.get(localName) ?? [])];
    if (modules.length !== 1) {
      return undefined;
    }
    return `${modules[0]}.${localName}`;
  }

  private resolveTermQName(
    moduleName: string,
    localName: string,
  ): string | undefined {
    const module = this.modules.get(moduleName);
    if (!module) {
      throw new MiniCoreCompileError(`Unknown module ${moduleName}`);
    }
    if (module.definitions.has(localName)) {
      return `${moduleName}.${localName}`;
    }
    const imported = module.imports.get(localName);
    if (imported) {
      return imported;
    }
    return this.resolveExportedQName(localName);
  }

  private resolveConstructorId(
    moduleName: string,
    localName: string,
  ): SymbolId | undefined {
    const candidates = this.constructorsByLocalName.get(localName);
    if (!candidates) {
      return undefined;
    }

    // 1. Prefer local module constructor(s)
    const localCandidates = [...candidates].filter((id) =>
      this.symbols[id]!.name.startsWith(`${moduleName}.`),
    );
    if (localCandidates.length === 1) {
      return localCandidates[0];
    }
    if (localCandidates.length > 1) {
      throw new MiniCoreCompileError(
        `Ambiguous constructor ${localName} in module ${moduleName}; candidates: ${localCandidates
          .map((id) => this.symbols[id]!.name)
          .join(", ")}`,
      );
    }

    const module = this.modules.get(moduleName);
    if (!module) {
      throw new MiniCoreCompileError(`Unknown module ${moduleName}`);
    }

    // 2. Imported constructor
    const importedQName = module.imports.get(localName);
    if (importedQName) {
      // Check for exact fully qualified name first (Module.Type.Ctor)
      const imported = this.constructorByQName.get(importedQName);
      if (imported !== undefined) {
        return imported;
      }

      // Check for module alias (Module.Ctor)
      const alias = this.constructorAliasByQName.get(importedQName);
      if (alias === "ambiguous") {
        throw new MiniCoreCompileError(
          `Imported constructor alias ${importedQName} is ambiguous`,
        );
      }
      if (alias !== undefined) {
        return alias;
      }

      // If the imported QName itself is ambiguous (e.g. Module.Name instead of Module.Type.Name)
      const importedCandidates = [...candidates].filter(
        (id) =>
          this.symbols[id]!.name.startsWith(`${importedQName}.`) ||
          this.symbols[id]!.name === importedQName,
      );
      if (importedCandidates.length === 1) return importedCandidates[0];
      if (importedCandidates.length > 1) {
        throw new MiniCoreCompileError(
          `Ambiguous imported constructor ${localName}; candidates: ${importedCandidates
            .map((id) => this.symbols[id]!.name)
            .join(", ")}`,
        );
      }
    }

    // 3. Exported/in-scope constructor if unambiguous
    const exportedQName = this.resolveExportedQName(localName);
    if (exportedQName) {
      const alias = this.constructorAliasByQName.get(exportedQName);
      if (alias === "ambiguous") {
        throw new MiniCoreCompileError(
          `Exported constructor alias ${exportedQName} is ambiguous`,
        );
      }
      if (alias !== undefined) {
        return alias;
      }
    }

    // 4. Local-name fallback only if unique across ALL modules
    if (candidates.size === 1) {
      return [...candidates][0];
    }

    throw new MiniCoreCompileError(
      `Ambiguous constructor ${localName}; candidates: ${[...candidates]
        .map((id) => this.symbols[id]!.name)
        .join(", ")}`,
    );
  }

  private isZeroQName(qName: string | undefined): boolean {
    return qName === "Nat.zero";
  }

  private isConstructorQName(qName: string): boolean {
    return (
      this.constructorByQName.has(qName) ||
      this.constructorAliasByQName.get(qName) !== undefined
    );
  }

  private functionSource(qName: string): {
    module: SourceModule;
    localName: string;
    definition: PolyDefinition;
  } {
    if (this.isConstructorQName(qName)) {
      throw new MiniCoreCompileError(
        `${qName} is a constructor, not a function`,
      );
    }
    const [moduleName, localName] = splitQualifiedName(qName);
    const module = this.modules.get(moduleName);
    if (!module) {
      throw new MiniCoreCompileError(`Unknown module ${moduleName}`);
    }
    const definition = requireTermDefinition(module, localName);
    if (definition.kind !== "poly") {
      throw new MiniCoreCompileError(`${qName} is not a MiniCore function`);
    }
    return { module, localName, definition };
  }

  private functionParams(qName: string): string[] {
    const primitive = MINI_PRIMITIVES.find(([n]) => n === qName);
    if (primitive) {
      return Array.from({ length: primitive[1] }, (_, i) => `arg${i}`);
    }

    const ctorId =
      this.constructorByQName.get(qName) ??
      this.constructorAliasByQName.get(qName);
    if (ctorId !== undefined && typeof ctorId !== "string") {
      const def = this.symbols[ctorId];
      if (def?.kind === "constructor") {
        return Array.from({ length: def.arity }, (_, i) => `field${i}`);
      }
    }

    const existing = this.callableSymbolsByQName.get(qName);
    if (existing !== undefined) {
      const def = this.symbols[existing];
      if (def?.kind === "primitive") {
        return Array.from({ length: def.arity }, (_, index) => `arg${index}`);
      }
    }

    try {
      const { definition } = this.functionSource(qName);
      return collectTopLevelParams(definition.term).params;
    } catch {
      if (existing !== undefined) {
        const def = this.symbols[existing];
        if (def?.kind === "function") {
          return Array.from({ length: def.arity }, (_, index) => `arg${index}`);
        }
      }
      throw new MiniCoreCompileError(
        `Cannot determine parameters for ${qName}`,
      );
    }
  }

  private analyzingCallableParams = new Set<string>();

  private isSpecialApplication(qName: string): boolean {
    return (
      qName === "Prelude.if" ||
      qName === "Prelude.and" ||
      qName === "Prelude.or" ||
      qName === "Prelude.matchList" ||
      qName === "Prelude.tail" ||
      qName === "Prelude.reverse" ||
      qName === "Prelude.fst" ||
      qName === "Prelude.snd" ||
      qName === "Prelude.readOne" ||
      qName === "Prelude.writeOne"
    );
  }

  private isConditionAsCalleeBoolEliminator(
    type: MiniType | undefined,
    hadTypeApplication: boolean,
    argCount: number,
  ): boolean {
    return type?.kind === "bool" && hadTypeApplication && argCount >= 2;
  }

  private analyzeCallableParams(qName: string): Set<string> {
    const cached = this.callableParamsCache.get(qName);
    if (cached) return cached;

    if (this.analyzingCallableParams.has(qName)) {
      return new Set();
    }

    if (this.isZeroQName(qName)) {
      const result = new Set<string>();
      this.callableParamsCache.set(qName, result);
      return result;
    }

    if (this.isSpecialApplication(qName)) {
      const result = new Set<string>();
      this.callableParamsCache.set(qName, result);
      return result;
    }

    const primitive = MINI_PRIMITIVES.find(([n]) => n === qName);
    if (primitive) {
      const result = new Set<string>();
      this.callableParamsCache.set(qName, result);
      return result;
    }

    if (this.isConstructorQName(qName)) {
      const result = new Set<string>();
      this.callableParamsCache.set(qName, result);
      return result;
    }

    this.analyzingCallableParams.add(qName);
    try {
      const { definition, module } = this.functionSource(qName);
      const { params, paramTypes, body } = collectTopLevelParams(
        definition.term,
      );
      const paramTypeByName = new Map(
        params.map((param, index) => [
          param,
          this.miniTypeFromBaseType(paramTypes[index]!, module.name),
        ]),
      );
      const callable = new Set<string>();

      const visit = (term: SystemFTerm, shadowed: Set<string>) => {
        switch (term.kind) {
          case "non-terminal": {
            const { head, args } = flattenApplication(term);
            const stripped = stripTypeApps(head);
            const strippedHead = stripped.term;

            if (strippedHead.kind === "systemF-var") {
              const isShadowed = shadowed.has(strippedHead.name);
              if (params.includes(strippedHead.name) && !isShadowed) {
                const headType = paramTypeByName.get(strippedHead.name);
                if (
                  !this.isConditionAsCalleeBoolEliminator(
                    headType,
                    stripped.stripped,
                    args.length,
                  )
                ) {
                  callable.add(strippedHead.name);
                }
              }

              const calledQName = isShadowed
                ? undefined
                : this.resolveTermQName(module.name, strippedHead.name);
              if (
                calledQName &&
                calledQName !== qName &&
                !this.isSpecialApplication(calledQName)
              ) {
                const calledCallable = this.analyzeCallableParams(calledQName);
                const calledParams = this.functionParams(calledQName);
                for (
                  let i = 0;
                  i < Math.min(args.length, calledParams.length);
                  i++
                ) {
                  if (calledCallable.has(calledParams[i]!)) {
                    const arg = stripTypeApps(args[i]!).term;
                    if (
                      arg.kind === "systemF-var" &&
                      params.includes(arg.name) &&
                      !shadowed.has(arg.name)
                    ) {
                      callable.add(arg.name);
                    }
                  }
                }
              }
            }
            visit(head, shadowed);
            args.forEach((arg) => visit(arg, shadowed));
            break;
          }
          case "systemF-let": {
            visit(term.value, shadowed);
            const nextShadowed = new Set(shadowed);
            nextShadowed.add(term.name);
            visit(term.body, nextShadowed);
            break;
          }
          case "systemF-match":
            visit(term.scrutinee, shadowed);
            term.arms.forEach((arm) => {
              const nextShadowed = new Set(shadowed);
              arm.params.forEach((p) => nextShadowed.add(p));
              visit(arm.body, nextShadowed);
            });
            break;
          case "systemF-abs": {
            const nextShadowed = new Set(shadowed);
            nextShadowed.add(term.name);
            visit(term.body, nextShadowed);
            break;
          }
          case "systemF-type-abs":
            visit(term.body, shadowed);
            break;
          case "systemF-type-app":
            visit(term.term, shadowed);
            break;
        }
      };

      visit(body, new Set());
      this.callableParamsCache.set(qName, callable);
      return callable;
    } finally {
      this.analyzingCallableParams.delete(qName);
    }
  }

  private ensureCallable(qName: string): SymbolId {
    if (this.isZeroQName(qName)) {
      throw new MiniCoreCompileError("Nat.zero is a literal, not a callable");
    }

    const existing = this.callableSymbolsByQName.get(qName);
    if (existing !== undefined) {
      if (this.functionStates.get(existing) === "declared") {
        this.compileFunction(qName, existing, undefined);
      }
      return existing;
    }

    return this.declareAndCompileFunction(qName, undefined);
  }

  private ensureSpecializedCallable(
    qName: string,
    staticBindings: StaticBinding[],
  ): SymbolId {
    const sorted = [...staticBindings].sort((a, b) =>
      a.paramName.localeCompare(b.paramName),
    );
    const suffix = sorted
      .map((b) => `${b.paramName}=${this.symbols[b.symbol]!.name}`)
      .join("$");
    const key = `${qName}$${suffix}`;

    const existing = this.specializedFunctions.get(key);
    if (existing !== undefined) {
      if (this.functionStates.get(existing) === "declared") {
        this.compileFunction(qName, existing, {
          symbolName: key,
          staticBindings: sorted,
        });
      }
      return existing;
    }
    const id = this.declareAndCompileFunction(qName, {
      symbolName: key,
      staticBindings: sorted,
    });
    this.specializedFunctions.set(key, id);
    return id;
  }

  private declareAndCompileFunction(
    qName: string,
    specialization: Specialization | undefined,
  ): SymbolId {
    const params = this.functionParams(qName).filter(
      (param) =>
        !specialization?.staticBindings.some((b) => b.paramName === param),
    );
    const id = this.addSymbol({
      kind: "function",
      name: specialization?.symbolName ?? qName,
      arity: params.length,
      params: [],
      body: { kind: "lit", value: { kind: "nat", value: 0n } },
    });
    this.metadata.functions.set(id, {
      symbol: id,
      paramTypes: Array.from({ length: params.length }, () => ({
        kind: "unknown",
      })),
      resultType: { kind: "unknown" },
      loweringHint:
        qName === "Prelude.if"
          ? {
              kind: "boolEliminator",
              mode: "functionStyle",
              conditionArg: 0,
              thenArg: 1,
              elseArg: 2,
            }
          : undefined,
    });
    if (!specialization) {
      this.callableSymbolsByQName.set(qName, id);
    } else {
      this.specializedFunctions.set(specialization.symbolName, id);
    }
    this.functionStates.set(id, "declared");
    this.compileFunction(qName, id, specialization);
    return id;
  }

  private compileFunction(
    qName: string,
    id: SymbolId,
    specialization: Specialization | undefined,
  ): void {
    const state = this.functionStates.get(id);
    if (state === "compiled" || state === "compiling") {
      return;
    }
    this.functionStates.set(id, "compiling");

    const { module, definition } = this.functionSource(qName);
    const { typeParams, params, paramTypes, body } = collectTopLevelParams(
      definition.term,
    );
    const locals = new Map<string, LocalId>();
    const localTypesByName = new Map<string, MiniType>();
    const localTypes = new Map<LocalId, MiniType>();
    const functionLocals = new Map<string, SymbolId>();
    const paramIds: LocalId[] = [];
    let nextLocalId = 0;

    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const paramType = this.miniTypeFromBaseType(paramTypes[i]!, module.name);
      const binding = specialization?.staticBindings.find(
        (b) => b.paramName === param,
      );
      if (binding) {
        functionLocals.set(param, binding.symbol);
        continue;
      }
      const localId = nextLocalId++;
      locals.set(param, localId);
      localTypes.set(localId, paramType);
      localTypesByName.set(param, paramType);
      paramIds.push(localId);
    }

    const ctx: LoweringContext = {
      fnSymbol: id,
      moduleName: module.name,
      locals,
      localTypes,
      localTypesByName,
      functionLocals,
      nextLocalId,
    };

    const miniParamTypes: MiniType[] = paramIds.map(
      (paramId) =>
        ctx.localTypes.get(paramId) ?? ({ kind: "unknown" } as MiniType),
    );

    let typeScheme: MiniType | undefined = definition.type
      ? this.miniTypeFromBaseType(definition.type, module.name)
      : undefined;

    let resultTypeHint: MiniType = { kind: "unknown" };
    const strippedBody = stripTypeAbs(body);
    if (strippedBody.kind === "systemF-match") {
      resultTypeHint = this.miniTypeFromBaseType(
        strippedBody.returnType,
        module.name,
      );
    } else if (typeScheme) {
      let current = typeScheme;
      // Skip type parameters in the scheme
      for (let i = 0; i < typeParams.length; i++) {
        if (current.kind === "forall") {
          current = current.body;
        } else {
          break;
        }
      }
      // Skip term parameters in the scheme
      for (let i = 0; i < params.length; i++) {
        if (current.kind === "fn") {
          current = current.result;
        } else {
          break;
        }
      }
      resultTypeHint = current;
    }

    // Set preliminary metadata for recursive calls
    this.metadata.functions.set(id, {
      symbol: id,
      paramTypes: miniParamTypes,
      resultType: resultTypeHint,
      typeScheme,
      loweringHint: this.metadata.functions.get(id)?.loweringHint,
    });

    const def = this.symbols[id];
    if (!def || def.kind !== "function") {
      throw new MiniCoreCompileError(`Internal symbol ${id} is not a function`);
    }
    def.params = paramIds;
    def.arity = paramIds.length;
    def.body = this.lowerTerm(body, ctx);
    this.metadata.localTypesByFunction.set(id, ctx.localTypes);

    const resultType = typeOfMiniCoreExpr(
      def.body,
      id,
      this.metadata,
      ctx.localTypes,
    );

    if (!typeScheme && typeParams.length > 0) {
      const fnType: MiniType = {
        kind: "fn",
        params: miniParamTypes,
        result: resultType,
      };
      typeScheme = {
        kind: "forall",
        params: typeParams,
        body: fnType,
      };
    }

    this.metadata.functions.set(id, {
      ...(this.metadata.functions.get(id) ?? { symbol: id }),
      symbol: id,
      paramTypes: miniParamTypes,
      resultType,
      typeScheme,
      loweringHint: this.metadata.functions.get(id)?.loweringHint,
    });
    this.functionStates.set(id, "compiled");
  }

  private markExportedSymbols(): void {
    for (const module of this.modules.values()) {
      for (const localName of module.exports) {
        const id = this.symbolsByName.get(`${module.name}.${localName}`);
        if (id !== undefined) {
          this.metadata.exportedSymbols.add(id);
        }
      }
    }
  }

  private allocLocal(
    ctx: LoweringContext,
    name: string,
    type: MiniType = { kind: "unknown" },
  ): LocalId {
    const id = ctx.nextLocalId++;
    if (name !== "_") {
      ctx.locals.set(name, id);
      ctx.localTypesByName.set(name, type);
    }
    ctx.localTypes.set(id, type);
    return id;
  }

  private withLocalScope<T>(
    ctx: LoweringContext,
    names: string[],
    typesOrFn: MiniType[] | ((ids: LocalId[]) => T),
    maybeFn?: (ids: LocalId[]) => T,
  ): T {
    const types = Array.isArray(typesOrFn)
      ? typesOrFn
      : names.map(() => ({ kind: "unknown" }) as MiniType);
    const fn = Array.isArray(typesOrFn) ? maybeFn! : typesOrFn;
    const previous = new Map(ctx.locals);
    const previousTypesByName = new Map(ctx.localTypesByName);
    const ids = names.map((name, index) =>
      this.allocLocal(ctx, name, types[index] ?? { kind: "unknown" }),
    );
    try {
      return fn(ids);
    } finally {
      ctx.locals = previous;
      ctx.localTypesByName = previousTypesByName;
    }
  }

  private lowerTerm(term: SystemFTerm, ctx: LoweringContext): Expr {
    switch (term.kind) {
      case "systemF-var":
        return this.lowerVar(term.name, ctx);
      case "systemF-type-app":
      case "systemF-type-abs": {
        const { term: inner, args: typeArgs } = stripTypeApps(term);
        if (inner.kind === "systemF-var") {
          return this.lowerVar(
            inner.name,
            ctx,
            typeArgs.map((t) => this.miniTypeFromBaseType(t, ctx.moduleName)),
          );
        }
        return this.lowerTerm(stripTypeAbs(inner), ctx);
      }
      case "systemF-let": {
        const value = this.lowerTerm(term.value, ctx);
        const valueType = term.typeAnnotation
          ? this.miniTypeFromBaseType(term.typeAnnotation, ctx.moduleName)
          : typeOfMiniCoreExpr(
              value,
              ctx.fnSymbol,
              this.metadata,
              ctx.localTypes,
            );
        return this.withLocalScope(ctx, [term.name], [valueType], (ids) => {
          const id = ids[0]!;
          const body = this.lowerTerm(term.body, ctx);
          return { kind: "let", bindings: [{ id, value }], body };
        });
      }
      case "systemF-match": {
        const scrutinee = this.lowerTerm(term.scrutinee, ctx);
        const scrutineeType = typeOfMiniCoreExpr(
          scrutinee,
          ctx.fnSymbol,
          this.metadata,
          ctx.localTypes,
        );
        return {
          kind: "case",
          scrutinee,
          alts: term.arms.map((arm) => {
            const constructor = this.resolveConstructorId(
              ctx.moduleName,
              arm.constructorName,
            );
            if (constructor === undefined) {
              throw new MiniCoreCompileError(
                `Unknown constructor ${arm.constructorName}`,
              );
            }
            const ctorInfo = this.metadata.constructors.get(constructor);
            let fieldTypes = ctorInfo?.fieldTypes ?? [];

            if (ctorInfo && scrutineeType.kind !== "unknown") {
              // Unification-based specialization:
              // unify the actual scrutinee type with the constructor's generic result type
              const subst = new Map<string, MiniType>();

              miniTypeUnify(scrutineeType, ctorInfo.resultType, subst);
              fieldTypes = fieldTypes.map((ft) =>
                substituteMiniType(ft, subst),
              );
            }

            return this.withLocalScope(
              ctx,
              arm.params,
              fieldTypes,
              (binders) => ({
                constructor,
                binders,
                body: this.lowerTerm(arm.body, ctx),
              }),
            );
          }),
        };
      }
      case "non-terminal":
        return this.lowerApplication(term, ctx);
      case "systemF-abs":
        throw new MiniCoreCompileError(
          "MiniCore does not support lambda values in expression position",
        );
    }
  }

  private lowerVar(
    name: string,
    ctx: LoweringContext,
    typeArgs: MiniType[] = [],
  ): Expr {
    const local = ctx.locals.get(name);
    if (local !== undefined) {
      if (typeArgs.length > 0) {
        throw new MiniCoreCompileError(
          `Local variable ${name} cannot be specialized with type arguments`,
        );
      }
      return { kind: "var", id: local };
    }

    const u8Match = /^__trip_u8_(\d+)$/.exec(name);
    if (u8Match) {
      return {
        kind: "lit",
        value: { kind: "u8", value: Number(u8Match[1]) },
      };
    }

    const natLiteral = parseNatLiteralIdentifier(name);
    if (natLiteral !== null) {
      return { kind: "lit", value: { kind: "nat", value: natLiteral } };
    }

    const constructor = this.resolveConstructorId(ctx.moduleName, name);
    if (constructor !== undefined) {
      const def = this.symbols[constructor];
      if (def?.kind !== "constructor" || def.arity !== 0) {
        throw new MiniCoreCompileError(
          `Constructor ${def?.name ?? name} needs fields`,
        );
      }
      return { kind: "con", target: constructor, fields: [], typeArgs };
    }

    const qName = this.resolveTermQName(ctx.moduleName, name);
    if (this.isZeroQName(qName)) {
      return { kind: "lit", value: { kind: "nat", value: 0n } };
    }
    if (qName) {
      return this.lowerTopLevelCall(qName, [], ctx, typeArgs);
    }

    throw new MiniCoreCompileError(`Unknown variable ${name}`);
  }

  private lowerApplication(term: SystemFTerm, ctx: LoweringContext): Expr {
    const runtimeIo = this.lowerRuntimeIoApplication(term, ctx);
    if (runtimeIo) {
      return runtimeIo;
    }

    const { head, args } = flattenApplication(term);
    const strippedHead = stripTypeApps(head);

    if (strippedHead.term.kind === "systemF-var") {
      const special = this.lowerSpecialApplication(
        strippedHead.term.name,
        args,
        ctx,
      );
      if (special) {
        return special;
      }

      const localFunction = ctx.functionLocals.get(strippedHead.term.name);
      if (localFunction !== undefined) {
        return this.lowerKnownCallable(
          localFunction,
          args,
          ctx,
          strippedHead.args.map((a) =>
            this.miniTypeFromBaseType(a, ctx.moduleName),
          ),
        );
      }

      const localType = ctx.localTypesByName.get(strippedHead.term.name);
      if (
        this.isConditionAsCalleeBoolEliminator(
          localType,
          strippedHead.stripped,
          args.length,
        )
      ) {
        return this.lowerConditionAsCalleeBoolEliminatorExpr(
          this.lowerTerm(strippedHead.term, ctx),
          args,
          ctx,
        );
      }

      const constructor = this.resolveConstructorId(
        ctx.moduleName,
        strippedHead.term.name,
      );
      if (constructor !== undefined) {
        const def = this.symbols[constructor];
        if (!def || def.kind !== "constructor") {
          throw new MiniCoreCompileError("Internal constructor mismatch");
        }
        if (args.length !== def.arity) {
          throw new MiniCoreCompileError(
            `${def.name} expects ${def.arity} field(s), got ${args.length}`,
          );
        }
        return {
          kind: "con",
          target: constructor,
          fields: args.map((arg) => this.lowerTerm(arg, ctx)),
          typeArgs: strippedHead.args.map((a) =>
            this.miniTypeFromBaseType(a, ctx.moduleName),
          ),
        };
      }

      const qName = this.resolveTermQName(
        ctx.moduleName,
        strippedHead.term.name,
      );
      if (this.isZeroQName(qName)) {
        if (args.length !== 0) {
          throw new MiniCoreCompileError("Nat.zero does not accept arguments");
        }
        return { kind: "lit", value: { kind: "nat", value: 0n } };
      }
      if (qName) {
        return this.lowerTopLevelCall(
          qName,
          args,
          ctx,
          strippedHead.args.map((a) =>
            this.miniTypeFromBaseType(a, ctx.moduleName),
          ),
        );
      }
    }

    if (strippedHead.stripped && args.length >= 2) {
      const condition = this.lowerTerm(strippedHead.term, ctx);
      const conditionType = typeOfMiniCoreExpr(
        condition,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      if (conditionType.kind === "bool") {
        return this.lowerConditionAsCalleeBoolEliminatorExpr(
          condition,
          args,
          ctx,
        );
      }
    }

    throw new MiniCoreCompileError(
      `Unsupported MiniCore application with head ${strippedHead.term.kind}`,
    );
  }

  private lowerRuntimeIoApplication(
    term: SystemFTerm,
    ctx: LoweringContext,
  ): Expr | undefined {
    const readOne = this.matchReadOneApplication(term, ctx);
    if (readOne) {
      return this.lowerReadOneContinuation(readOne.continuation, ctx);
    }

    const writeOne = this.matchWriteOneApplication(term, ctx);
    if (writeOne) {
      return this.lowerWriteOneContinuation(
        writeOne.byte,
        writeOne.continuation,
        ctx,
      );
    }

    return undefined;
  }

  private matchReadOneApplication(
    term: SystemFTerm,
    ctx: LoweringContext,
  ): { continuation: SystemFTerm } | undefined {
    if (term.kind !== "non-terminal") return undefined;
    const head = stripTypeApps(term.lft).term;
    if (head.kind !== "systemF-var") return undefined;
    if (
      this.resolveTermQName(ctx.moduleName, head.name) !== "Prelude.readOne"
    ) {
      return undefined;
    }
    return { continuation: term.rgt };
  }

  private matchWriteOneApplication(
    term: SystemFTerm,
    ctx: LoweringContext,
  ): { byte: SystemFTerm; continuation: SystemFTerm } | undefined {
    if (term.kind !== "non-terminal") return undefined;
    const applied = stripTypeApps(term.lft).term;
    if (applied.kind !== "non-terminal") return undefined;

    const { head, args } = flattenApplication(applied);
    const strippedHead = stripTypeApps(head).term;
    if (strippedHead.kind !== "systemF-var") return undefined;
    if (
      this.resolveTermQName(ctx.moduleName, strippedHead.name) !==
      "Prelude.writeOne"
    ) {
      return undefined;
    }
    if (args.length !== 1) {
      throw new MiniCoreCompileError(
        `Prelude.writeOne expects one byte argument before its continuation, got ${args.length}`,
      );
    }
    return { byte: args[0]!, continuation: term.rgt };
  }

  private lowerReadOneContinuation(
    continuation: SystemFTerm,
    ctx: LoweringContext,
  ): Expr {
    const lambda = stripTypeAbs(continuation);
    if (lambda.kind !== "systemF-abs") {
      throw new MiniCoreCompileError(
        "Prelude.readOne continuation must be a lambda",
      );
    }
    this.assertU8Type(
      this.miniTypeFromBaseType(lambda.typeAnnotation, ctx.moduleName),
      "Prelude.readOne continuation parameter",
    );
    return this.withLocalScope(
      ctx,
      [lambda.name],
      [{ kind: "u8" }],
      ([byte]) => ({
        kind: "let",
        bindings: [
          {
            id: byte!,
            value: { kind: "runtimeCall", name: "trip_read_one", args: [] },
          },
        ],
        body: this.lowerTerm(lambda.body, ctx),
      }),
    );
  }

  private lowerWriteOneContinuation(
    byteTerm: SystemFTerm,
    continuation: SystemFTerm,
    ctx: LoweringContext,
  ): Expr {
    const byteExpr = this.lowerTerm(byteTerm, ctx);
    this.assertU8Type(
      typeOfMiniCoreExpr(byteExpr, ctx.fnSymbol, this.metadata, ctx.localTypes),
      "Prelude.writeOne byte argument",
    );

    const lambda = stripTypeAbs(continuation);
    if (lambda.kind !== "systemF-abs") {
      throw new MiniCoreCompileError(
        "Prelude.writeOne continuation must be a lambda",
      );
    }
    this.assertU8Type(
      this.miniTypeFromBaseType(lambda.typeAnnotation, ctx.moduleName),
      "Prelude.writeOne continuation parameter",
    );

    return this.withLocalScope(
      ctx,
      [lambda.name],
      [{ kind: "u8" }],
      ([byte]) => {
        const writeResult = this.allocLocal(ctx, "_", { kind: "unit" });
        return {
          kind: "let",
          bindings: [
            { id: byte!, value: byteExpr },
            {
              id: writeResult,
              value: {
                kind: "runtimeCall",
                name: "trip_write_one",
                args: [{ kind: "var", id: byte! }],
              },
            },
          ],
          body: this.lowerTerm(lambda.body, ctx),
        };
      },
    );
  }

  private assertU8Type(type: MiniType, context: string): void {
    if (!miniTypeEquals(type, { kind: "u8" })) {
      throw new MiniCoreCompileError(
        `${context} must be U8, got ${miniTypeToString(type)}`,
      );
    }
  }

  private lowerSpecialApplication(
    name: string,
    args: SystemFTerm[],
    ctx: LoweringContext,
  ): Expr | undefined {
    const qName = this.resolveTermQName(ctx.moduleName, name);

    if (qName === "Prelude.if") {
      if (args.length !== 3) {
        throw new MiniCoreCompileError("Prelude.if expects 3 term arguments");
      }
      return this.lowerBoolCase(
        this.lowerTerm(args[0]!, ctx),
        this.lowerIfBranch(args[1]!, ctx),
        this.lowerIfBranch(args[2]!, ctx),
        ctx,
      );
    }

    if (qName === "Prelude.and") {
      if (args.length !== 2) {
        throw new MiniCoreCompileError("Prelude.and expects 2 term arguments");
      }
      return this.lowerBoolCase(
        this.lowerTerm(args[0]!, ctx),
        this.lowerTerm(args[1]!, ctx),
        {
          kind: "con",
          target: this.requireConstructor("Prelude.false"),
          fields: [],
          typeArgs: [],
        },
        ctx,
      );
    }

    if (qName === "Prelude.or") {
      if (args.length !== 2) {
        throw new MiniCoreCompileError("Prelude.or expects 2 term arguments");
      }
      return this.lowerBoolCase(
        this.lowerTerm(args[0]!, ctx),
        {
          kind: "con",
          target: this.requireConstructor("Prelude.true"),
          fields: [],
          typeArgs: [],
        },
        this.lowerTerm(args[1]!, ctx),
        ctx,
      );
    }

    if (qName === "Prelude.matchList") {
      if (args.length !== 3) {
        throw new MiniCoreCompileError(
          "Prelude.matchList expects 3 term arguments",
        );
      }
      const scrutinee = this.lowerTerm(args[0]!, ctx);
      const scrutineeType = typeOfMiniCoreExpr(
        scrutinee,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      const headType =
        scrutineeType.kind === "data" && scrutineeType.args.length > 0
          ? scrutineeType.args[0]!
          : ({ kind: "unknown" } as MiniType);
      const tailType = scrutineeType;
      const onNil = this.lowerTerm(args[1]!, ctx);
      const nil = this.requireConstructor("Prelude.nil");
      const cons = this.requireConstructor("Prelude.cons");
      const onCons = stripTypeAbs(args[2]!);
      if (onCons.kind !== "systemF-abs") {
        throw new MiniCoreCompileError(
          "matchList cons branch must be a lambda",
        );
      }
      const tailLambda = stripTypeAbs(onCons.body);
      if (tailLambda.kind !== "systemF-abs") {
        throw new MiniCoreCompileError(
          "matchList cons branch must take two arguments",
        );
      }
      const consAlt = this.withLocalScope(
        ctx,
        [onCons.name, tailLambda.name],
        [headType, tailType],
        (binders) => ({
          constructor: cons,
          binders,
          body: this.lowerTerm(tailLambda.body, ctx),
        }),
      );
      return {
        kind: "case",
        scrutinee,
        alts: [
          {
            constructor: nil,
            binders: [],
            body: onNil,
          },
          consAlt,
        ],
      };
    }

    if (qName === "Prelude.tail") {
      if (args.length !== 1) {
        throw new MiniCoreCompileError("Prelude.tail expects 1 term argument");
      }
      const nil = this.requireConstructor("Prelude.nil");
      const cons = this.requireConstructor("Prelude.cons");
      const scrutinee = this.lowerTerm(args[0]!, ctx);
      const scrutineeType = typeOfMiniCoreExpr(
        scrutinee,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      const headType =
        scrutineeType.kind === "data" && scrutineeType.args.length > 0
          ? scrutineeType.args[0]!
          : ({ kind: "unknown" } as MiniType);
      const tailType = scrutineeType;
      const typeArgs = scrutineeType.kind === "data" ? scrutineeType.args : [];

      return this.withLocalScope(
        ctx,
        ["__tail_head", "__tail_tail"],
        [headType, tailType],
        (binders) => ({
          kind: "case",
          scrutinee,
          alts: [
            {
              constructor: nil,
              binders: [],
              body: { kind: "con", target: nil, fields: [], typeArgs },
            },
            {
              constructor: cons,
              binders,
              body: { kind: "var", id: binders[1]! },
            },
          ],
        }),
      );
    }

    if (qName === "Prelude.reverse") {
      if (args.length !== 1) {
        throw new MiniCoreCompileError(
          "Prelude.reverse expects 1 term argument",
        );
      }
      const reverseAcc = this.ensureCallable("Prelude.reverseAcc");
      const nil = this.requireConstructor("Prelude.nil");
      const listTerm = this.lowerTerm(args[0]!, ctx);
      const listType = typeOfMiniCoreExpr(
        listTerm,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      const typeArgs = listType.kind === "data" ? listType.args : [];

      return {
        kind: "call",
        target: reverseAcc,
        args: [listTerm, { kind: "con", target: nil, fields: [], typeArgs }],
        typeArgs,
      };
    }

    if (qName === "Prelude.fst" || qName === "Prelude.snd") {
      if (args.length !== 1) {
        throw new MiniCoreCompileError(`${qName} expects 1 term argument`);
      }
      const pair = this.requireConstructor("Prelude.MkPair");
      const scrutinee = this.lowerTerm(args[0]!, ctx);
      const scrutineeType = typeOfMiniCoreExpr(
        scrutinee,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      const fieldTypes =
        scrutineeType.kind === "data" && scrutineeType.args.length === 2
          ? [scrutineeType.args[0]!, scrutineeType.args[1]!]
          : ([{ kind: "unknown" }, { kind: "unknown" }] as MiniType[]);

      return this.withLocalScope(
        ctx,
        ["__pair_fst", "__pair_snd"],
        fieldTypes,
        (binders) => ({
          kind: "case",
          scrutinee,
          alts: [
            {
              constructor: pair,
              binders,
              body: {
                kind: "var",
                id: qName === "Prelude.fst" ? binders[0]! : binders[1]!,
              },
            },
          ],
        }),
      );
    }

    return undefined;
  }

  private lowerIfBranch(term: SystemFTerm, ctx: LoweringContext): Expr {
    const stripped = stripTypeAbs(term);
    if (stripped.kind === "systemF-abs") {
      const paramType = this.miniTypeFromBaseType(
        stripped.typeAnnotation,
        ctx.moduleName,
      );
      return this.withLocalScope(ctx, [stripped.name], [paramType], () =>
        this.lowerTerm(stripped.body, ctx),
      );
    }
    return this.lowerTerm(term, ctx);
  }

  private lowerConditionAsCalleeBoolEliminatorExpr(
    condition: Expr,
    args: SystemFTerm[],
    ctx: LoweringContext,
  ): Expr {
    const thenTerm = args[0];
    const elseTerm = args[1];
    if (thenTerm === undefined || elseTerm === undefined) {
      throw new MiniCoreCompileError(
        "Bool eliminator expects then and else arguments",
      );
    }
    const rest = args.slice(2);
    return this.lowerBoolCase(
      condition,
      this.lowerTerm(applyTermArgs(thenTerm, rest), ctx),
      this.lowerTerm(applyTermArgs(elseTerm, rest), ctx),
      ctx,
    );
  }

  private lowerBoolCase(
    scrutinee: Expr,
    ifTrue: Expr,
    ifFalse: Expr,
    ctx?: LoweringContext,
  ): Expr {
    if (ctx) {
      const scrutineeType = typeOfMiniCoreExpr(
        scrutinee,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      const boolType = this.metadata.bool?.type ?? { kind: "bool" };
      if (!miniTypeEquals(scrutineeType, boolType)) {
        throw new MiniCoreCompileError(
          `Bool eliminator condition must be Bool, got ${miniTypeToString(
            scrutineeType,
          )}`,
        );
      }

      const trueType = typeOfMiniCoreExpr(
        ifTrue,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );
      const falseType = typeOfMiniCoreExpr(
        ifFalse,
        ctx.fnSymbol,
        this.metadata,
        ctx.localTypes,
      );

      const subst = new Map<string, MiniType>();
      try {
        miniTypeUnify(trueType, falseType, subst);
      } catch (e) {
        throw new MiniCoreCompileError(
          `Bool eliminator branches must have unifiable types, got ${miniTypeToString(
            trueType,
          )} and ${miniTypeToString(falseType)}`,
        );
      }
    }

    return {
      kind: "case",
      scrutinee,
      alts: [
        {
          constructor: this.requireConstructor("Prelude.false"),
          binders: [],
          body: ifFalse,
        },
        {
          constructor: this.requireConstructor("Prelude.true"),
          binders: [],
          body: ifTrue,
        },
      ],
    };
  }

  private lowerTopLevelCall(
    qName: string,
    args: SystemFTerm[],
    ctx: LoweringContext,
    typeArgs: MiniType[] = [],
  ): Expr {
    const params = this.functionParams(qName);
    const callableParams = this.analyzeCallableParams(qName);

    if (callableParams.size > 0) {
      if (args.length !== params.length) {
        throw new MiniCoreCompileError(
          `MiniCore specialization for ${qName} requires all ${params.length} arguments (got ${args.length}); partial application not supported`,
        );
      }

      const staticBindings: StaticBinding[] = [];
      const runtimeArgs: SystemFTerm[] = [];

      for (let i = 0; i < params.length; i++) {
        const param = params[i]!;
        if (callableParams.has(param)) {
          staticBindings.push({
            paramName: param,
            symbol: this.resolveFunctionArgument(args[i]!, ctx, qName, param),
          });
        } else {
          runtimeArgs.push(args[i]!);
        }
      }

      const symbol = this.ensureSpecializedCallable(qName, staticBindings);
      return this.lowerKnownCallable(symbol, runtimeArgs, ctx, typeArgs);
    }

    const symbol = this.ensureCallable(qName);
    return this.lowerKnownCallable(symbol, args, ctx, typeArgs);
  }

  private lowerKnownCallable(
    symbol: SymbolId,
    args: SystemFTerm[],
    ctx: LoweringContext,
    typeArgs: MiniType[] = [],
  ): Expr {
    const def = this.symbols[symbol];
    if (!def || (def.kind !== "function" && def.kind !== "primitive")) {
      throw new MiniCoreCompileError(`Symbol ${symbol} is not callable`);
    }
    if (args.length !== def.arity) {
      throw new MiniCoreCompileError(
        `${def.name} expects ${def.arity} argument(s), got ${args.length}`,
      );
    }

    const loweredArgs = args.map((arg) => this.lowerTerm(arg, ctx));
    return def.kind === "primitive"
      ? { kind: "prim", target: symbol, args: loweredArgs, typeArgs }
      : { kind: "call", target: symbol, args: loweredArgs, typeArgs };
  }

  private resolveFunctionArgument(
    term: SystemFTerm,
    ctx: LoweringContext,
    calledQName: string,
    paramName: string,
  ): SymbolId {
    const stripped = stripTypeApps(term).term;
    if (stripped.kind !== "systemF-var") {
      throw new MiniCoreCompileError(
        `MiniCore cannot specialize dynamic function argument for parameter ${paramName} of ${calledQName}. Use SKI backend or add closure support.`,
      );
    }
    const localFunction = ctx.functionLocals.get(stripped.name);
    if (localFunction !== undefined) {
      return localFunction;
    }
    const localId = ctx.locals.get(stripped.name);
    if (localId !== undefined) {
      throw new MiniCoreCompileError(
        `MiniCore cannot specialize dynamic function argument ${stripped.name} for parameter ${paramName} of ${calledQName}. Use SKI backend or add closure support.`,
      );
    }
    const qName = this.resolveTermQName(ctx.moduleName, stripped.name);
    if (!qName) {
      throw new MiniCoreCompileError(
        `Unknown function argument ${stripped.name} for parameter ${paramName} of ${calledQName}`,
      );
    }
    return this.ensureCallable(qName);
  }

  private requireConstructor(name: string): SymbolId {
    const id = this.symbolsByName.get(name);
    if (id === undefined) {
      throw new MiniCoreCompileError(`Missing constructor ${name}`);
    }
    return id;
  }
}

export function compileMiniCoreModules(
  modules: MiniCoreModuleSource[],
  entryModuleName?: string,
  options: CompileMiniCoreModulesOptions = {},
): Program {
  const sourceModules = modules.map(parseSourceModule);
  const entryModule =
    entryModuleName ??
    sourceModules.find((module) => module.exports.has("main"))?.name;
  if (!entryModule) {
    throw new MiniCoreCompileError("No MiniCore entry module found");
  }
  const builder = new MiniCoreBuilder(sourceModules);
  const program = builder.build(`${entryModule}.main`);
  validateMiniCoreProgram(program, {
    requireNullaryEntry: options.requireNullaryEntry,
  });
  return program;
}
