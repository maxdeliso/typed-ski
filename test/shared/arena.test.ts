import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import {
  CONTROL_PTR_BIT,
  controlIndex,
  isControlPtr,
  isValuePtr,
  makeControlPtr,
} from "../../lib/shared/arena.ts";

it("control pointer helpers classify and decode pointers", () => {
  const valuePtr = 0x12345678;
  const controlPtr = makeControlPtr(valuePtr);

  assert.deepStrictEqual(controlPtr, (valuePtr | CONTROL_PTR_BIT) >>> 0);

  assert.ok(isValuePtr(valuePtr));
  assert.deepStrictEqual(isControlPtr(valuePtr), false);

  assert.ok(isControlPtr(controlPtr));
  assert.deepStrictEqual(isValuePtr(controlPtr), false);
  assert.deepStrictEqual(controlIndex(controlPtr), valuePtr);
});
