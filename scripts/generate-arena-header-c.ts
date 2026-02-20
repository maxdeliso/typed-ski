/**
 * Generate TypeScript constants for SabHeader field indices and Ring header layout
 * from C header file.
 */

const cHeaderFile = await Deno.readTextFile("c/arena.h");

function parseCStruct(source: string, structName: string) {
  const structRegex = new RegExp(
    `typedef struct\\s*{([^}]*)}\\s*${structName};`,
    "s",
  );
  const match = source.match(structRegex);
  if (!match) throw new Error(`Could not find struct ${structName}`);

  const fields: string[] = [];
  const fieldLines = match[1].split(";");
  for (const line of fieldLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Handle "type name" or "type name[size]" or "type _pad[size]"
    const parts = trimmed.split(/\s+/);
    const name = parts[parts.length - 1];
    if (name && !name.startsWith("_pad")) {
      // Remove array brackets if present
      const cleanName = name.split("[")[0];
      if (cleanName) fields.push(cleanName);
    }
  }
  return fields;
}

const fields = parseCStruct(cHeaderFile, "SabHeader");

let enumContent = "";
for (let i = 0; i < fields.length; i++) {
  const f = fields[i];
  const constName = f.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  enumContent += `  ${constName} = ${i},\n`;
}

let fieldsContent = "";
for (let i = 0; i < fields.length; i++) {
  fieldsContent += `  "${fields[i]}"${i === fields.length - 1 ? "" : ","}\n`;
}

const content = `/**
 * SabHeader field indices (generated from c/arena.h)
 *
 * These constants represent the byte offsets (divided by 4) into the SabHeader
 * struct when viewed as a Uint32Array.
 */
export enum SabHeaderField {
${enumContent}}

export const SABHEADER_HEADER_SIZE_U32 = ${fields.length};
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
