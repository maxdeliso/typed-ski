import type { LlvmMainWrapper, LlvmTargetProfile } from "./llvm/types.ts";
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
  mainWrapper?: LlvmMainWrapper;
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

function wrapperToString(wrapper: LlvmMainWrapper | undefined): string {
  return wrapper?.kind ?? "none";
}

function parseWrapper(value: string): LlvmMainWrapper | undefined {
  switch (value) {
    case "none":
      return undefined;
    case "c-main":
      return { kind: "c-main" };
    case "stdin-list-u8":
      return { kind: "stdin-list-u8" };
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
    case "wasm32-unknown-unknown":
    case "wasm32-wasi":
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
    `wrapper ${wrapperToString(bundle.mainWrapper)}`,
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
    `wrapper ${wrapperToString(bundle.mainWrapper)}`,
    `modules ${bundle.modules.length}`,
  ];

  for (const module of bundle.modules) {
    lines.push(`module ${module.name} ${module.source.length}`);
  }

  return lines.join("\n");
}

function unsupportedTripSideTopLevelSyntax(source: string): boolean {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("native ") || trimmed.startsWith("opaque ")) {
      return true;
    }
  }
  return false;
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
      return true;
    case "native":
    case "lambda":
      return false;
  }
}

function summarizeParsedModule(name: string, source: string): string[] {
  if (unsupportedTripSideTopLevelSyntax(source)) {
    throw new TripBundleV1Error("Parse error");
  }

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
  const types = program.terms.filter((term) => term.kind === "type");
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

  lines.push("native 0", `poly ${poly.length}`);
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

export function summarizeTripBundleV1ParsedModules(input: Uint8Array): string {
  const bundle = parseTripBundleV1(input);
  const lines = [
    "OK",
    "version bundle-parse-summary-v1",
    `entry ${bundle.entryModule}`,
    `target ${targetToString(bundle.target)}`,
    `wrapper ${wrapperToString(bundle.mainWrapper)}`,
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
  const mainWrapper = parseWrapper(requireDirective(line, "wrapper"));

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

  return { entryModule, target, mainWrapper, modules };
}
