import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

function resolveRequired(val, name) {
  if (!val) {
    console.error(`ERROR: Missing required argument ${name}`);
    process.exit(1);
  }
  return resolve(val);
}

const normalize = (s) => s.replace(/\r\n/g, "\n");

async function main() {
  const args = getArgs();

  if (args.debugPaths) {
    console.log("Debug Paths:");
    console.log(`  process.cwd(): ${process.cwd()}`);
    console.log(`  process.execPath: ${process.execPath}`);
    console.log(`  --input: ${args.input}`);
    console.log(`  --c-out: ${args.cOut}`);
    console.log(`  --ts-out: ${args.tsOut}`);
  }

  const inputPath = resolveRequired(args.input, "--input");
  const defFile = await readFile(inputPath, "utf8");

  const fields = [];
  const lines = defFile.split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\s*X\(\s*([A-Za-z0-9_]+)\s*,\s*(U32|U64)\s*,\s*(\d+)\s*,\s*(true|false)\s*\)/,
    );
    if (match) {
      const name = match[1];
      const type = match[2];
      const count = parseInt(match[3], 10);
      const isAtomic = match[4] === "true";
      const is64 = type === "U64";
      fields.push({
        name,
        type,
        count,
        isAtomic,
        is64,
        u32Slots: (is64 ? 2 : 1) * count,
        alignment: is64 ? 8 : 4,
      });
    }
  }

  const hashSource = fields
    .map((f) => `${f.name}:${f.type}:${f.count}:${f.isAtomic}`)
    .join("|");
  const layoutHash = parseInt(
    createHash("md5").update(hashSource).digest("hex").slice(0, 8),
    16,
  );

  const ABI_VERSION = 1;
  let currentByteOffset = 0;
  const indexByField = [];
  let structFields = "";
  let maxWorkers = 64;

  for (const f of fields) {
    if (currentByteOffset % f.alignment !== 0) {
      currentByteOffset += f.alignment - (currentByteOffset % f.alignment);
    }

    indexByField.push(currentByteOffset / 4);

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

    currentByteOffset += f.u32Slots * 4;
  }

  if (currentByteOffset % 8 !== 0) {
    currentByteOffset += 8 - (currentByteOffset % 8);
  }
  const totalBytes = currentByteOffset;

  let enumEntries = "";
  let cAsserts = "";
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.name.startsWith("PAD_")) continue;
    const slotIdx = indexByField[i];
    enumEntries += `  ${f.name} = ${slotIdx},\n`;

    const cName = f.name.toLowerCase();
    const byteOffset = slotIdx * 4;
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

export const SABHEADER_HEADER_SIZE_U32 = ${totalBytes / 4};
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

  if (args.tsOut) {
    const outPath = resolve(args.tsOut);
    if (args.verify) {
      const existing = await readFile(outPath, "utf8").catch(() => "");
      if (normalize(existing) !== normalize(tsContent)) {
        console.error(
          `ERROR: ${args.tsOut} is out of sync with arena_layout.def`,
        );
        process.exit(1);
      }
    } else {
      await writeFile(outPath, tsContent, "utf8");
    }
  }

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
_Static_assert(sizeof(SabHeader) == ${totalBytes}, "SabHeader size mismatch");

#endif
`;
  if (args.cOut) {
    const outPath = resolve(args.cOut);
    if (args.verify) {
      const existing = await readFile(outPath, "utf8").catch(() => "");
      if (normalize(existing) !== normalize(cContent)) {
        console.error(
          `ERROR: ${args.cOut} is out of sync with arena_layout.def`,
        );
        process.exit(1);
      }
    } else {
      await writeFile(outPath, cContent, "utf8");
    }
  }

  if (!args.quiet && !args.verify) {
    console.log(
      `Generated headers from def file (ABI v${ABI_VERSION}, Hash 0x${layoutHash.toString(16)}, ${totalBytes} bytes).`,
    );
  }
}

function getArgs() {
  const args = {};
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--input") args.input = process.argv[++i];
    if (arg === "--ts-out") args.tsOut = process.argv[++i];
    if (arg === "--c-out") args.cOut = process.argv[++i];
    if (arg === "--quiet") args.quiet = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--debug-paths") args.debugPaths = true;
  }
  return args;
}

await main();
