import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

async function main() {
  const defFile = await readFile("core/arena_layout.def", "utf8");

  const fields: {
    name: string;
    type: string;
    count: number;
    isAtomic: boolean;
    u32Slots: number;
    is64: boolean;
  }[] = [];

  const lines = defFile.split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\s*X\(\s*([A-Za-z0-9_]+)\s*,\s*(U32|U64)\s*,\s*(\d+)\s*,\s*(true|false)\s*\)/,
    );
    if (match) {
      const name = match[1]!;
      const type = match[2]!;
      const count = parseInt(match[3]!, 10);
      const isAtomic = match[4] === "true";
      const is64 = type === "U64";
      fields.push({
        name,
        type,
        count,
        isAtomic,
        is64,
        u32Slots: (is64 ? 2 : 1) * count,
      });
    }
  }

  // Calculate layout hash for runtime verification
  const hashSource = fields
    .map((f) => `${f.name}:${f.type}:${f.count}:${f.isAtomic}`)
    .join("|");
  const layoutHash = parseInt(
    createHash("md5").update(hashSource).digest("hex").slice(0, 8),
    16,
  );

  const ABI_VERSION = 1;

  let currentU32 = 0;
  const indexByField: number[] = [];
  let structFields = "";
  let maxWorkers = 64;

  for (const f of fields) {
    indexByField.push(currentU32);
    currentU32 += f.u32Slots;

    const cType = f.is64 ? "uint64_t" : "uint32_t";
    const finalType = f.isAtomic ? `_Atomic ${cType}` : cType;
    const cName = f.name.toLowerCase();

    if (f.count > 1) {
      if (f.name === "WORKER_EPOCHS") maxWorkers = f.count;
      const arraySize =
        f.name === "WORKER_EPOCHS" ? "MAX_WORKERS" : f.count.toString();
      structFields += `  ${finalType} ${cName}[${arraySize}];\n`;
    } else {
      structFields += `  ${finalType} ${cName};\n`;
    }
  }
  const totalU32 = currentU32;

  let enumEntries = "";
  let cAsserts = "";
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.name.startsWith("PAD_")) continue;
    enumEntries += `  ${f.name} = ${indexByField[i]!},\n`;

    const cName = f.name.toLowerCase();
    const byteOffset = indexByField[i]! * 4;
    cAsserts += `_Static_assert(offsetof(SabHeader, ${cName}) == ${byteOffset}, "${cName} offset mismatch");\n`;
  }

  const tsContent = `/**
 * SabHeader field indices (generated from core/arena_layout.def)
 *
 * These constants represent the index into the SabHeader when viewed as a Uint32Array.
 * uint64_t fields occupy two consecutive indices (lo, hi).
 */
export enum SabHeaderField {
${enumEntries}}

export const SABHEADER_HEADER_SIZE_U32 = ${totalU32};
export const SABHEADER_ABI_VERSION = ${ABI_VERSION};
export const SABHEADER_LAYOUT_HASH = ${layoutHash};

/**
 * Ring buffer header constants
 */

const CACHE_LINE_BYTES = 64;
const CACHE_LINE_U32 = CACHE_LINE_BYTES / 4;

/** @internal */
export const RING_HEADER_BYTES = CACHE_LINE_BYTES * 3;
/** @internal */
export const RING_HEADER_U32 = RING_HEADER_BYTES / 4;
/** @internal */
export const RING_HEAD_INDEX = 0;
/** @internal */
export const RING_NOT_FULL_INDEX = 1;
/** @internal */
export const RING_TAIL_INDEX = CACHE_LINE_U32;
/** @internal */
export const RING_NOT_EMPTY_INDEX = RING_TAIL_INDEX + 1;
/** @internal */
export const RING_MASK_INDEX = RING_TAIL_INDEX + CACHE_LINE_U32;
/** @internal */
export const RING_ENTRIES_INDEX = RING_MASK_INDEX + 1;
`;

  await writeFile("lib/evaluator/arenaHeader.generated.ts", tsContent, "utf8");

  const cContent = `/* Generated from core/arena_layout.def. Do not edit directly. */
#ifndef ARENA_LAYOUT_GENERATED_H
#define ARENA_LAYOUT_GENERATED_H

#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

#define MAX_WORKERS ${maxWorkers}
#define SAB_ABI_VERSION ${ABI_VERSION}
#define SAB_LAYOUT_HASH ${layoutHash}u

typedef struct {
${structFields}} SabHeader;

// Validate struct layout against fixed wire format
${cAsserts}
_Static_assert(sizeof(SabHeader) == ${totalU32 * 4}, "SabHeader size mismatch");

#endif
`;
  await writeFile("core/arena_layout.generated.h", cContent, "utf8");

  console.log(
    `Generated headers from def file (ABI v${ABI_VERSION}, Hash 0x${layoutHash.toString(16)}, ${totalU32 * 4} bytes).`,
  );
}

await main();
