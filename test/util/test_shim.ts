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
    return itFn(name, fn, options);
  };
};

// @ts-ignore
if (typeof Bun !== "undefined") {
  // @ts-ignore
  const bunTest = await import("bun:test");

  testRunner = {
    describe: bunTest.describe,
    it: wrapItBun(bunTest.it),
  };
} else {
  // @ts-ignore
  const nodeTest = await import("node:test");
  testRunner = {
    describe: nodeTest.describe,
    it: wrapItNode(nodeTest.it),
  };
}

export const describe = testRunner.describe;
export const it = testRunner.it;
