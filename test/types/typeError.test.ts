import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import { TypeError } from "../../lib/types/typeError.ts";

describe("TypeError", () => {
  it("should be an instance of Error", () => {
    const error = new TypeError("test error message");
    assert.ok(error instanceof Error);
  });

  it("should store the error message", () => {
    const message = "test type error message";
    const error = new TypeError(message);
    assert.strictEqual(error.message, message);
  });
});
