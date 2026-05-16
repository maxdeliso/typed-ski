import type { LlvmTargetProfile } from "./llvm/types.ts";
import { compareAscii } from "../shared/canonical.ts";
import { parseTripLang } from "../parser/tripLang.ts";
import type { TripLangProgram, TripLangTerm } from "../meta/trip.ts";

export const TRIP_BUNDLE_V1_MAGIC = "TRIP-BUNDLE-V1";

export interface TripBundleV1Module {
  name: string;
  source: string;
}

export interface TripBundleV1 {
  entryModule: string;
  target: LlvmTargetProfile;
  emitMainWrapper?: boolean;
  modules: TripBundleV1Module[];
}

export class TripBundleV1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TripBundleV1Error";
  }
}

const LF = 0x0a;

function asciiBytes(kind: string, value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const byte = value.charCodeAt(i);
    if (byte > 0x7f) {
      throw new TripBundleV1Error(
        `Bundle-v1 ${kind} contains non-ASCII byte at offset ${i}`,
      );
    }
    bytes[i] = byte;
  }
  return bytes;
}

function asciiString(kind: string, bytes: Uint8Array, offset = 0): string {
  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte > 0x7f) {
      throw new TripBundleV1Error(
        `Bundle-v1 ${kind} contains non-ASCII byte at offset ${offset + i}`,
      );
    }
    text += String.fromCharCode(byte);
  }
  return text;
}

function validateAscii(kind: string, value: string): void {
  asciiBytes(kind, value);
}

function validateName(kind: string, name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TripBundleV1Error(`Invalid ${kind} name in bundle-v1: ${name}`);
  }
}

function targetToString(target: LlvmTargetProfile): string {
  return target.kind;
}

function wrapperToString(wrapper: boolean | undefined): string {
  return wrapper ? "enabled" : "none";
}

function parseWrapper(value: string): boolean {
  switch (value) {
    case "none":
      return false;
    case "enabled":
      return true;
    default:
      throw new TripBundleV1Error(
        `Unsupported bundle-v1 wrapper kind: ${value}`,
      );
  }
}

function parseBundleTarget(value: string): LlvmTargetProfile {
  switch (value) {
    case "arm64-apple-darwin":
    case "generic":
    case "x86_64-unknown-linux-gnu":
    case "x86_64-pc-windows-msvc":
      return { kind: value };
    default:
      throw new TripBundleV1Error(
        `Unsupported bundle-v1 LLVM target: ${value}`,
      );
  }
}

function readLine(input: Uint8Array, offset: number): [string, number] {
  let newline = offset;
  while (newline < input.length && input[newline] !== LF) {
    newline++;
  }
  const line = asciiString(
    "directive line",
    input.subarray(offset, newline),
    offset,
  );
  if (newline === input.length) {
    return [line, input.length];
  }
  return [line, newline + 1];
}

function requireDirective(line: string, directive: string): string {
  const prefix = `${directive} `;
  if (!line.startsWith(prefix)) {
    throw new TripBundleV1Error(
      `Expected bundle-v1 directive '${directive}', got: ${line}`,
    );
  }
  const value = line.slice(prefix.length);
  if (value.length === 0) {
    throw new TripBundleV1Error(
      `Bundle-v1 directive '${directive}' requires a value`,
    );
  }
  return value;
}

function parsePositiveInteger(kind: string, value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TripBundleV1Error(`Invalid bundle-v1 ${kind}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TripBundleV1Error(`Bundle-v1 ${kind} is too large: ${value}`);
  }
  return parsed;
}

export function serializeTripBundleV1(bundle: TripBundleV1): Uint8Array {
  validateName("entry module", bundle.entryModule);
  const names = new Set<string>();
  const lines = [
    TRIP_BUNDLE_V1_MAGIC,
    `entry ${bundle.entryModule}`,
    `target ${targetToString(bundle.target)}`,
    `wrapper ${wrapperToString(bundle.emitMainWrapper)}`,
    `modules ${bundle.modules.length}`,
  ];

  for (const module of [...bundle.modules].sort((left, right) =>
    compareAscii(left.name, right.name),
  )) {
    validateName("module", module.name);
    validateAscii(`module ${module.name} source`, module.source);
    if (names.has(module.name)) {
      throw new TripBundleV1Error(
        `Duplicate module in bundle-v1: ${module.name}`,
      );
    }
    names.add(module.name);
    lines.push(`module ${module.name} ${module.source.length}`);
    lines.push(module.source);
  }

  if (!names.has(bundle.entryModule)) {
    throw new TripBundleV1Error(
      `Entry module ${bundle.entryModule} is not present in bundle-v1`,
    );
  }

  return asciiBytes("serialized bundle", lines.join("\n"));
}

export function serializeTripBundleV1ToString(bundle: TripBundleV1): string {
  return asciiString("serialized bundle", serializeTripBundleV1(bundle));
}

export function summarizeTripBundleV1(input: Uint8Array): string {
  const bundle = parseTripBundleV1(input);
  const lines = [
    "OK",
    "version bundle-v1",
    `entry ${bundle.entryModule}`,
    `target ${targetToString(bundle.target)}`,
    `wrapper ${wrapperToString(bundle.emitMainWrapper)}`,
    `modules ${bundle.modules.length}`,
  ];

  for (const module of bundle.modules) {
    lines.push(`module ${module.name} ${module.source.length}`);
  }

  return lines.join("\n");
}

function parsedModuleName(program: TripLangProgram): string {
  const moduleTerms = program.terms.filter((term) => term.kind === "module");
  if (moduleTerms.length === 0) {
    throw new TripBundleV1Error("missing module declaration");
  }
  if (moduleTerms.length > 1) {
    throw new TripBundleV1Error("multiple module declarations");
  }
  return moduleTerms[0]!.name;
}

function supportedParseSummaryTerm(term: TripLangTerm): boolean {
  switch (term.kind) {
    case "module":
    case "import":
    case "export":
    case "data":
    case "type":
    case "poly":
    case "combinator":
    case "native":
      return true;
    case "lambda":
      return false;
  }
}

function summarizeParsedModule(name: string, source: string): string[] {
  let program: TripLangProgram;
  try {
    program = parseTripLang(source);
  } catch {
    throw new TripBundleV1Error("Parse error");
  }

  if (program.terms.some((term) => !supportedParseSummaryTerm(term))) {
    throw new TripBundleV1Error("Parse error");
  }

  const declared = parsedModuleName(program);
  if (declared !== name) {
    throw new TripBundleV1Error("source module mismatch");
  }

  const imports = program.terms.filter((term) => term.kind === "import");
  const exports = program.terms.filter((term) => term.kind === "export");
  const data = program.terms.filter((term) => term.kind === "data");
  const types = program.terms.filter(
    (term) => term.kind === "type" && term.opaque !== true,
  );
  const opaques = program.terms.filter(
    (term) => term.kind === "type" && term.opaque === true,
  );
  const natives = program.terms.filter((term) => term.kind === "native");
  const poly = program.terms.filter((term) => term.kind === "poly");
  const combinators = program.terms.filter(
    (term) => term.kind === "combinator",
  );

  const lines = [
    `module ${name}`,
    `declared ${declared}`,
    `imports ${imports.length}`,
  ];

  for (const term of imports) {
    if (term.kind === "import") {
      lines.push(`import ${term.name} ${term.ref}`);
    }
  }

  lines.push(`exports ${exports.length}`);
  for (const term of exports) {
    if (term.kind === "export") {
      lines.push(`export ${term.name}`);
    }
  }

  lines.push(`data ${data.length}`);
  for (const term of data) {
    if (term.kind === "data") {
      lines.push(`data ${term.name}`);
      for (const ctor of term.constructors) {
        lines.push(`ctor ${ctor.name} ${ctor.fields.length}`);
      }
    }
  }

  lines.push(`type ${types.length}`);
  for (const term of types) {
    if (term.kind === "type") {
      lines.push(`type ${term.name}`);
    }
  }

  lines.push(`opaque ${opaques.length}`);
  for (const term of opaques) {
    if (term.kind === "type") {
      lines.push(`opaque ${term.name}`);
    }
  }

  lines.push(`native ${natives.length}`);
  for (const term of natives) {
    if (term.kind === "native") {
      lines.push(`native ${term.name}`);
    }
  }

  lines.push(`poly ${poly.length}`);
  for (const term of poly) {
    if (term.kind === "poly") {
      lines.push(`poly ${term.name}`);
    }
  }

  lines.push(`combinator ${combinators.length}`);
  for (const term of combinators) {
    if (term.kind === "combinator") {
      lines.push(`combinator ${term.name}`);
    }
  }

  return lines;
}

export function summarizeTripBundleV1Inventory(input: Uint8Array): string {
  const bundle = parseTripBundleV1(input);
  const programs = new Map<string, TripLangProgram>();
  const globalExports = new Map<string, string[]>(); // symbol -> modules exporting it

  for (const mod of bundle.modules) {
    try {
      const program = parseTripLang(mod.source);
      programs.set(mod.name, program);

      for (const term of program.terms) {
        if (term.kind === "export") {
          if (!globalExports.has(term.name)) {
            globalExports.set(term.name, []);
          }
          globalExports.get(term.name)!.push(mod.name);
        }
      }
    } catch {
      return "ERR:Parse error\n";
    }
  }

  const lines = [
    "OK",
    "version bundle-inventory-v1",
    `entry ${bundle.entryModule}`,
    `target ${targetToString(bundle.target)}`,
    `wrapper ${wrapperToString(bundle.emitMainWrapper)}`,
    `modules ${bundle.modules.length}`,
  ];

  for (const mod of bundle.modules) {
    const program = programs.get(mod.name)!;
    lines.push(`module ${mod.name}`);

    const declared = parsedModuleName(program);
    lines.push(`declared ${declared}`);

    const imps = program.terms.filter((t) => t.kind === "import");
    lines.push(`imports ${imps.length}`);
    for (const imp of imps) {
      if (imp.kind === "import") {
        let status = "RESOLVED";
        const originProgram = programs.get(imp.name);
        if (!originProgram) {
          status = "MISSING_MODULE";
        } else {
          const exported = originProgram.terms.some(
            (t) => t.kind === "export" && t.name === imp.ref,
          );
          if (!exported) {
            status = "NOT_EXPORTED";
          }
        }
        lines.push(`import ${imp.name} ${imp.ref} ${status}`);
      }
    }

    const exps = program.terms.filter((t) => t.kind === "export");
    lines.push(`exports ${exps.length}`);
    for (const exp of exps) {
      if (exp.kind === "export") {
        const origins = globalExports.get(exp.name) ?? [];
        let status = origins.length > 1 ? "AMBIGUOUS" : "OK";

        if (status === "OK") {
          const definitions = program.terms.filter(
            (t) =>
              (t.name === exp.name &&
                (t.kind === "poly" ||
                  t.kind === "combinator" ||
                  t.kind === "data" ||
                  t.kind === "type" ||
                  t.kind === "native")) ||
              (t.kind === "data" &&
                t.constructors.some((ctor) => ctor.name === exp.name)),
          );
          if (definitions.length === 0) {
            status = "EXPORT_UNDEFINED";
          }
        }

        lines.push(`export ${exp.name} ${status}`);
      }
    }

    const datas = program.terms.filter((t) => t.kind === "data");
    lines.push(`data ${datas.length}`);
    for (const d of datas) {
      if (d.kind === "data") {
        lines.push(`data ${d.name}`);
        for (const ctor of d.constructors) {
          lines.push(`ctor ${ctor.name} ${ctor.fields.length}`);
        }
      }
    }

    const types = program.terms.filter(
      (t) => t.kind === "type" && t.opaque !== true,
    );
    lines.push(`type ${types.length}`);
    for (const t of types) {
      lines.push(`type ${t.name}`);
    }

    const opaques = program.terms.filter(
      (t) => t.kind === "type" && t.opaque === true,
    );
    lines.push(`opaque ${opaques.length}`);
    for (const t of opaques) {
      lines.push(`opaque ${t.name}`);
    }

    const natives = program.terms.filter((t) => t.kind === "native");
    lines.push(`native ${natives.length}`);
    for (const t of natives) {
      lines.push(`native ${t.name}`);
    }

    const polys = program.terms.filter((t) => t.kind === "poly");
    lines.push(`poly ${polys.length}`);
    for (const t of polys) {
      lines.push(`poly ${t.name}`);
    }

    const combinators = program.terms.filter((t) => t.kind === "combinator");
    lines.push(`combinator ${combinators.length}`);
    for (const t of combinators) {
      lines.push(`combinator ${t.name}`);
    }
  }

  return lines.join("\n") + "\n";
}

type ModuleEnvDefinitionKind =
  | "poly"
  | "combinator"
  | "data"
  | "type"
  | "opaque"
  | "native";

interface ModuleEnvModuleInfo {
  name: string;
  terms: TripLangProgram["terms"];
}

interface ModuleEnvImportInfo {
  moduleName: string;
  from: string;
  symbol: string;
}

interface ModuleEnvExportInfo {
  moduleName: string;
  symbol: string;
}

interface ModuleEnvDefinitionInfo {
  moduleName: string;
  name: string;
  kind: ModuleEnvDefinitionKind;
}

interface ModuleEnvDataTypeInfo {
  qName: string;
  localName: string;
  id: number;
}

interface ModuleEnvConstructorInfo {
  qName: string;
  localName: string;
  alias: string;
  dataName: string;
  dataTypeId: number;
  symbolId: number;
  tag: number;
  total: number;
  arity: number;
}

interface ModuleEnvAliasInfo {
  alias: string;
  target: string | "AMBIGUOUS";
}

interface ModuleEnvPrimitiveInfo {
  qName: string;
  symbolId: number;
  arity: number;
}

const MODULE_ENV_PRIMITIVES: Array<[string, number]> = [
  ["Nat.succ", 1],
  ["Nat.add", 2],
  ["Nat.mul", 2],
  ["Nat.lte", 2],
  ["Prelude.not", 1],
  ["Prelude.eqU8", 2],
  ["Prelude.ltU8", 2],
  ["Prelude.addU8", 2],
  ["Prelude.subU8", 2],
  ["Prelude.divU8", 2],
  ["Prelude.modU8", 2],
  ["Prelude.error", 0],
];

function moduleEnvDefinitionKind(
  term: TripLangTerm,
): ModuleEnvDefinitionKind | undefined {
  switch (term.kind) {
    case "poly":
      return "poly";
    case "combinator":
      return "combinator";
    case "data":
      return "data";
    case "type":
      return term.opaque === true ? "opaque" : "type";
    case "native":
      return "native";
    default:
      return undefined;
  }
}

function moduleEnvParsedModuleName(program: TripLangProgram): string {
  return parsedModuleName(program);
}

function moduleEnvParseModules(bundle: TripBundleV1): ModuleEnvModuleInfo[] {
  return bundle.modules.map((module) => {
    let program: TripLangProgram;
    try {
      program = parseTripLang(module.source);
    } catch {
      throw new TripBundleV1Error("Parse error");
    }
    const declared = moduleEnvParsedModuleName(program);
    if (declared !== module.name) {
      throw new TripBundleV1Error("source module mismatch");
    }
    return { name: module.name, terms: program.terms };
  });
}

function moduleEnvExportStatus(
  moduleName: string,
  symbol: string,
  exports: ModuleEnvExportInfo[],
  definitions: ModuleEnvDefinitionInfo[],
  constructors: ModuleEnvConstructorInfo[],
): string {
  const origins = exports.filter((info) => info.symbol === symbol);
  if (origins.length > 1) {
    return "AMBIGUOUS";
  }
  if (
    definitions.some(
      (info) => info.moduleName === moduleName && info.name === symbol,
    ) ||
    constructors.some((info) => info.alias === `${moduleName}.${symbol}`)
  ) {
    return "OK";
  }
  return "EXPORT_UNDEFINED";
}

function moduleEnvImportStatus(
  from: string,
  symbol: string,
  modules: ModuleEnvModuleInfo[],
  exports: ModuleEnvExportInfo[],
): string {
  if (!modules.some((module) => module.name === from)) {
    return "MISSING_MODULE";
  }
  if (
    !exports.some((info) => info.moduleName === from && info.symbol === symbol)
  ) {
    return "NOT_EXPORTED";
  }
  return "RESOLVED";
}

/**
 * Emits the deterministic Trip-side module metadata contract used by the
 * bootstrap bridge before expression lowering.
 */
export function summarizeTripBundleV1ModuleEnv(input: Uint8Array): string {
  const bundle = parseTripBundleV1(input);
  const modules = moduleEnvParseModules(bundle);
  const imports: ModuleEnvImportInfo[] = [];
  const exports: ModuleEnvExportInfo[] = [];
  const definitions: ModuleEnvDefinitionInfo[] = [];
  const dataTypes: ModuleEnvDataTypeInfo[] = [
    { qName: "Prelude.Bool", localName: "Bool", id: 0 },
    { qName: "Prelude.List", localName: "List", id: 1 },
  ];
  const opaques: ModuleEnvDefinitionInfo[] = [];
  const natives: ModuleEnvDefinitionInfo[] = [];
  let nextTypeId = 2;

  for (const module of modules) {
    for (const term of module.terms) {
      switch (term.kind) {
        case "import":
          imports.push({
            moduleName: module.name,
            from: term.name,
            symbol: term.ref,
          });
          break;
        case "export":
          exports.push({ moduleName: module.name, symbol: term.name });
          break;
        case "data":
          definitions.push({
            moduleName: module.name,
            name: term.name,
            kind: "data",
          });
          dataTypes.push({
            qName: `${module.name}.${term.name}`,
            localName: term.name,
            id: nextTypeId++,
          });
          break;
        case "type": {
          const kind: ModuleEnvDefinitionKind =
            term.opaque === true ? "opaque" : "type";
          const info: ModuleEnvDefinitionInfo = {
            moduleName: module.name,
            name: term.name,
            kind,
          };
          definitions.push(info);
          if (kind === "opaque") {
            opaques.push(info);
          }
          break;
        }
        case "native": {
          const info = {
            moduleName: module.name,
            name: term.name,
            kind: "native" as const,
          };
          definitions.push(info);
          natives.push(info);
          break;
        }
        case "poly":
        case "combinator": {
          const kind = moduleEnvDefinitionKind(term);
          if (kind) {
            definitions.push({
              moduleName: module.name,
              name: term.name,
              kind,
            });
          }
          break;
        }
      }
    }
  }

  const constructors: ModuleEnvConstructorInfo[] = [
    {
      qName: "Prelude.false",
      localName: "false",
      alias: "Prelude.false",
      dataName: "Bool",
      dataTypeId: 0,
      symbolId: 0,
      tag: 0,
      total: 2,
      arity: 0,
    },
    {
      qName: "Prelude.true",
      localName: "true",
      alias: "Prelude.true",
      dataName: "Bool",
      dataTypeId: 0,
      symbolId: 1,
      tag: 1,
      total: 2,
      arity: 0,
    },
    {
      qName: "Prelude.nil",
      localName: "nil",
      alias: "Prelude.nil",
      dataName: "List",
      dataTypeId: 1,
      symbolId: 2,
      tag: 0,
      total: 2,
      arity: 0,
    },
    {
      qName: "Prelude.cons",
      localName: "cons",
      alias: "Prelude.cons",
      dataName: "List",
      dataTypeId: 1,
      symbolId: 3,
      tag: 1,
      total: 2,
      arity: 2,
    },
  ];
  let nextSymbolId = 4;
  for (const module of modules) {
    for (const term of module.terms) {
      if (term.kind !== "data") continue;
      const dataType = dataTypes.find(
        (info) => info.qName === `${module.name}.${term.name}`,
      );
      if (!dataType) continue;
      term.constructors.forEach((ctor, tag) => {
        constructors.push({
          qName: `${module.name}.${term.name}.${ctor.name}`,
          localName: ctor.name,
          alias: `${module.name}.${ctor.name}`,
          dataName: term.name,
          dataTypeId: dataType.id,
          symbolId: nextSymbolId++,
          tag,
          total: term.constructors.length,
          arity: ctor.fields.length,
        });
      });
    }
  }

  const aliasTargets = new Map<string, string | "AMBIGUOUS">();
  for (const ctor of constructors) {
    const existing = aliasTargets.get(ctor.alias);
    if (existing === undefined) {
      aliasTargets.set(ctor.alias, ctor.qName);
    } else if (existing !== ctor.qName) {
      aliasTargets.set(ctor.alias, "AMBIGUOUS");
    }
  }
  const aliases: ModuleEnvAliasInfo[] = [];
  const seenAliases = new Set<string>();
  for (const ctor of constructors) {
    if (seenAliases.has(ctor.alias)) continue;
    seenAliases.add(ctor.alias);
    aliases.push({ alias: ctor.alias, target: aliasTargets.get(ctor.alias)! });
  }

  const primitives: ModuleEnvPrimitiveInfo[] = MODULE_ENV_PRIMITIVES.map(
    ([qName, arity], index) => ({
      qName,
      symbolId: nextSymbolId + index,
      arity,
    }),
  );

  const lines = ["OK", "version module-env-v1", `modules ${modules.length}`];
  for (const module of modules) {
    lines.push(`module ${module.name}`);

    const moduleImports = imports.filter(
      (info) => info.moduleName === module.name,
    );
    lines.push(`imports ${moduleImports.length}`);
    for (const info of moduleImports) {
      lines.push(
        `import ${info.from} ${info.symbol} ${moduleEnvImportStatus(
          info.from,
          info.symbol,
          modules,
          exports,
        )}`,
      );
    }

    const moduleExports = exports.filter(
      (info) => info.moduleName === module.name,
    );
    lines.push(`exports ${moduleExports.length}`);
    for (const info of moduleExports) {
      lines.push(
        `export ${info.symbol} ${moduleEnvExportStatus(
          module.name,
          info.symbol,
          exports,
          definitions,
          constructors,
        )}`,
      );
    }

    const moduleDefinitions = definitions.filter(
      (info) => info.moduleName === module.name,
    );
    lines.push(`definitions ${moduleDefinitions.length}`);
    for (const info of moduleDefinitions) {
      lines.push(`definition ${info.kind} ${info.name}`);
    }

    const moduleOpaques = opaques.filter(
      (info) => info.moduleName === module.name,
    );
    lines.push(`opaque ${moduleOpaques.length}`);
    for (const info of moduleOpaques) {
      lines.push(`opaque ${info.name}`);
    }

    const moduleNatives = natives.filter(
      (info) => info.moduleName === module.name,
    );
    lines.push(`native ${moduleNatives.length}`);
    for (const info of moduleNatives) {
      lines.push(`native ${info.name}`);
    }
  }

  lines.push(`data-types ${dataTypes.length}`);
  for (const info of dataTypes) {
    lines.push(`datatype ${info.id} ${info.qName} ${info.localName}`);
  }

  lines.push(`constructors ${constructors.length}`);
  for (const info of constructors) {
    lines.push(
      `constructor ${info.symbolId} ${info.qName} ${info.localName} ${info.alias} data#${info.dataTypeId} tag ${info.tag} total ${info.total} arity ${info.arity}`,
    );
  }

  lines.push(`aliases ${aliases.length}`);
  for (const info of aliases) {
    lines.push(`alias ${info.alias} ${info.target}`);
  }

  lines.push(`primitives ${primitives.length}`);
  for (const info of primitives) {
    lines.push(`primitive ${info.symbolId} ${info.qName} arity ${info.arity}`);
  }

  return `${lines.join("\n")}\n`;
}

export function summarizeTripBundleV1ParsedModules(input: Uint8Array): string {
  const bundle = parseTripBundleV1(input);
  const lines = [
    "OK",
    "version bundle-parse-summary-v1",
    `entry ${bundle.entryModule}`,
    `target ${targetToString(bundle.target)}`,
    `wrapper ${wrapperToString(bundle.emitMainWrapper)}`,
    `modules ${bundle.modules.length}`,
  ];

  for (const module of bundle.modules) {
    lines.push(...summarizeParsedModule(module.name, module.source));
  }

  return `${lines.join("\n")}\n`;
}

export function parseTripBundleV1String(input: string): TripBundleV1 {
  return parseTripBundleV1(asciiBytes("input", input));
}

export function parseTripBundleV1(input: Uint8Array): TripBundleV1 {
  let offset = 0;
  let line: string;

  [line, offset] = readLine(input, offset);
  if (line !== TRIP_BUNDLE_V1_MAGIC) {
    throw new TripBundleV1Error(
      `Invalid bundle-v1 magic: ${line || "<empty>"}`,
    );
  }

  [line, offset] = readLine(input, offset);
  const entryModule = requireDirective(line, "entry");
  validateName("entry module", entryModule);

  [line, offset] = readLine(input, offset);
  const target = parseBundleTarget(requireDirective(line, "target"));

  [line, offset] = readLine(input, offset);
  const emitMainWrapper = parseWrapper(requireDirective(line, "wrapper"));

  [line, offset] = readLine(input, offset);
  const moduleCount = parsePositiveInteger(
    "module count",
    requireDirective(line, "modules"),
  );

  const modules: TripBundleV1Module[] = [];
  const names = new Set<string>();
  let previousModuleName: string | undefined;
  for (let i = 0; i < moduleCount; i++) {
    [line, offset] = readLine(input, offset);
    const parts = line.split(" ");
    if (parts.length !== 3 || parts[0] !== "module") {
      throw new TripBundleV1Error(
        `Expected bundle-v1 module header, got: ${line}`,
      );
    }
    const name = parts[1]!;
    validateName("module", name);
    if (names.has(name)) {
      throw new TripBundleV1Error(`Duplicate module in bundle-v1: ${name}`);
    }
    if (
      previousModuleName !== undefined &&
      compareAscii(previousModuleName, name) >= 0
    ) {
      throw new TripBundleV1Error(
        `Bundle-v1 modules must be sorted by ASCII module name: ${previousModuleName} before ${name}`,
      );
    }
    previousModuleName = name;
    names.add(name);

    const length = parsePositiveInteger("module byte length", parts[2]!);
    if (offset + length > input.length) {
      throw new TripBundleV1Error(
        `Bundle-v1 module ${name} ended before ${length} byte(s)`,
      );
    }
    const sourceBytes = input.subarray(offset, offset + length);
    const source = asciiString(`module ${name} source`, sourceBytes, offset);
    offset += length;
    if (i !== moduleCount - 1 && input[offset] === LF) {
      offset += 1;
    } else if (i !== moduleCount - 1) {
      throw new TripBundleV1Error(
        `Bundle-v1 module ${name} is not followed by a newline`,
      );
    } else if (offset !== input.length) {
      throw new TripBundleV1Error("Bundle-v1 has trailing bytes");
    }
    modules.push({ name, source });
  }

  if (!names.has(entryModule)) {
    throw new TripBundleV1Error(
      `Entry module ${entryModule} is not present in bundle-v1`,
    );
  }

  if (offset !== input.length) {
    throw new TripBundleV1Error("Bundle-v1 has trailing bytes");
  }

  return { entryModule, target, emitMainWrapper, modules };
}
