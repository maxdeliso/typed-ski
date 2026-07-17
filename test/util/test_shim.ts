/**
 * Test shim to provide a consistent interface between Node.js and Bun.
 */

import { TEST_TIMEOUT_MS } from "../../lib/constants.ts";

let testRunner: any;

const parseArgs = (arg2: any, arg3?: any) => {
  let fn: any;
  const defaultTimeout = TEST_TIMEOUT_MS;
  let options: any = { timeout: defaultTimeout };

  if (typeof arg2 === "function") {
    fn = arg2;
    if (typeof arg3 === "number") {
      options.timeout = arg3;
    } else if (typeof arg3 === "object") {
      options = { ...options, ...arg3 };
    }
  } else {
    options = { ...options, ...arg2 };
    fn = arg3;
  }
  return { fn, options };
};

const wrapItNode = (itFn: any) => {
  return (name: string, arg2: any, arg3?: any) => {
    const { fn, options } = parseArgs(arg2, arg3);
    return itFn(name, options, fn);
  };
};

const wrapItBun = (itFn: any) => {
  return (name: string, arg2: any, arg3?: any) => {
    const { fn, options } = parseArgs(arg2, arg3);
    if (options.skip) {
      // @ts-ignore
      return testRunnerSkip.it.skip(name, fn);
    }
    return itFn(name, fn, options.timeout);
  };
};

let testRunnerSkip: any;

// @ts-ignore
if (typeof Bun !== "undefined") {
  // @ts-ignore
  const bunTest = await import("bun:test");
  testRunnerSkip = bunTest;
  testRunner = {
    describe: bunTest.describe,
    it: wrapItBun(bunTest.it),
    before: bunTest.beforeAll,
    after: bunTest.afterAll,
  };
} else {
  // @ts-ignore
  const nodeTest = await import("node:test");
  testRunner = {
    describe: nodeTest.describe,
    it: wrapItNode(nodeTest.it),
    before: nodeTest.before,
    after: nodeTest.after,
  };
}

export const describe = testRunner.describe;
export const it = testRunner.it;
export const before = testRunner.before;
export const after = testRunner.after;
