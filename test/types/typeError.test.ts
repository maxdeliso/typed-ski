import { test } from "node:test";
import { expect } from "../util/assertions.ts";

import { TypeError } from "../../lib/types/typeError.ts";

test("TypeError", async (t) => {
  await t.test("should be an instance of Error", () => {
    const error = new TypeError("test error message");
    expect(error).to.be.an.instanceof(Error);
  });

  await t.test("should store the error message", () => {
    const message = "test type error message";
    const error = new TypeError(message);
    expect(error.message).to.equal(message);
  });
});
