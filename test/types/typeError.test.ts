import { expect } from "npm:chai";

import { TypeError } from "../../lib/types/typeError.ts";

Deno.test("TypeError", async (t) => {
  await t.step("should be an instance of Error", () => {
    const error = new TypeError("test error message");
    expect(error).to.be.an.instanceof(Error);
  });

  await t.step("should store the error message", () => {
    const message = "test type error message";
    const error = new TypeError(message);
    expect(error.message).to.equal(message);
  });
});
