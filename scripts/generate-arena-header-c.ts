/**
 * Generate TypeScript constants for SabHeader field indices and Ring header layout
 * from C header file.
 */

const cHeaderFile = await Deno.readTextFile("c/arena.h");

type FieldLayout = {
  name: string;
  size: number;
  align: number;
};

function alignUp(offset: number, align: number): number {
  return (offset + align - 1) & ~(align - 1);
}

function parseFieldLayout(line: string): FieldLayout | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const name = parts[parts.length - 1];
  if (!name || name.startsWith("_pad")) {
    return null;
  }

  const cleanName = name.split("[")[0];
  if (!cleanName) return null;

  const type = parts.slice(0, -1).join(" ");
  switch (type) {
    case "uint32_t":
    case "atomic_uint":
      return { name: cleanName, size: 4, align: 4 };
    case "uint64_t":
    case "_Atomic uint64_t":
      return { name: cleanName, size: 8, align: 8 };
    default:
      throw new Error(`Unsupported SabHeader field type: ${type}`);
  }
}

function parseCStruct(source: string, structName: string) {
  const structRegex = new RegExp(
    `typedef struct\\s*{([^}]*)}\\s*${structName};`,
    "s",
  );
  const match = source.match(structRegex);
  if (!match) throw new Error(`Could not find struct ${structName}`);

  const fields: FieldLayout[] = [];
  const fieldLines = match[1].split(";");
  for (const line of fieldLines) {
    const field = parseFieldLayout(line);
    if (field) {
      fields.push(field);
    }
  }
  return fields;
}

const fields = parseCStruct(cHeaderFile, "SabHeader");

let byteOffset = 0;
const indexByField: number[] = [];
for (const f of fields) {
  byteOffset = alignUp(byteOffset, f.align);
  indexByField.push(byteOffset / 4);
  byteOffset += f.size;
}
const structAlign = Math.max(...fields.map((field) => field.align), 4);
const totalU32 = alignUp(byteOffset, structAlign) / 4;

let enumContent = "";
for (let i = 0; i < fields.length; i++) {
  const f = fields[i];
  const constName = f.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  enumContent += `  ${constName} = ${indexByField[i]!},\n`;
}

let fieldsContent = "";
for (let i = 0; i < fields.length; i++) {
  fieldsContent += `  "${fields[i]!.name}"${
    i === fields.length - 1 ? "" : ","
  }\n`;
}

const content = `/**
 * SabHeader field indices (generated from c/arena.h)
 *
 * These constants represent the index into the SabHeader when viewed as a Uint32Array.
 * uint64_t fields (offset_nodes, offset_buckets) occupy two consecutive indices (lo, hi).
 */
export enum SabHeaderField {
${enumContent}}

export const SABHEADER_HEADER_SIZE_U32 = ${totalU32};
export const SABHEADER_HEADER_FIELDS = [
${fieldsContent}] as const;

/**
 * Ring buffer header constants
 */
const CACHE_LINE_BYTES = 64;
const CACHE_LINE_U32 = CACHE_LINE_BYTES / 4;

export const RING_HEADER_BYTES = CACHE_LINE_BYTES * 3;
export const RING_HEADER_U32 = RING_HEADER_BYTES / 4;
export const RING_HEAD_INDEX = 0;
export const RING_NOT_FULL_INDEX = 1;
export const RING_TAIL_INDEX = CACHE_LINE_U32;
export const RING_NOT_EMPTY_INDEX = RING_TAIL_INDEX + 1;
export const RING_MASK_INDEX = RING_TAIL_INDEX + CACHE_LINE_U32;
export const RING_ENTRIES_INDEX = RING_MASK_INDEX + 1;
`;

await Deno.writeTextFile("lib/evaluator/arenaHeader.generated.ts", content);
console.log(`Generated arena header from C with ${fields.length} fields.`);
