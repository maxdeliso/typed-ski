import { assert, assertEquals } from "std/assert";

import {
  CONTROL_PTR_BIT,
  controlIndex,
  isControlPtr,
  isValuePtr,
  makeControlPtr,
} from "../../lib/shared/arena.ts";

Deno.test("control pointer helpers classify and decode pointers", () => {
  const valuePtr = 0x12345678;
  const controlPtr = makeControlPtr(valuePtr);

  assertEquals(controlPtr, (valuePtr | CONTROL_PTR_BIT) >>> 0);

  assert(isValuePtr(valuePtr));
  assertEquals(isControlPtr(valuePtr), false);

  assert(isControlPtr(controlPtr));
  assertEquals(isValuePtr(controlPtr), false);
  assertEquals(controlIndex(controlPtr), valuePtr);
});
