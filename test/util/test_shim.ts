/**
 * Test shim to provide a consistent interface between Node.js and Bun.
 */

let testRunner: any;

const universalWaitFor = async (
  fn: () => any,
  options?: { interval?: number; timeout?: number },
) => {
  const interval = options?.interval ?? 50;
  const timeout = options?.timeout ?? 2000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      return await fn();
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  return await fn();
};

const parseArgs = (arg2: any, arg3?: any) => {
  let fn: any;
  let options: any = { timeout: 60000 };

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

  const shimmedMock = {
    ...bunTest.mock,
    method: (obj: any, methodName: string, implementation: any) => {
      const spy = bunTest.spyOn(obj, methodName);
      if (implementation) {
        spy.mockImplementation(implementation);
      }
      return {
        mock: {
          restore: () => spy.mockRestore(),
        },
      };
    },
  };

  testRunner = {
    ...bunTest,
    it: wrapItBun(bunTest.it),
    test: wrapItBun(bunTest.test),
    before: bunTest.beforeAll,
    after: bunTest.afterAll,
    mock: shimmedMock,
    waitFor: universalWaitFor,
  };
} else {
  // @ts-ignore
  const nodeTest = await import("node:test");
  testRunner = {
    ...nodeTest,
    it: wrapItNode(nodeTest.it),
    test: wrapItNode(nodeTest.test),
    waitFor: universalWaitFor,
  };
}

export const describe = testRunner.describe;
export const it = testRunner.it;
export const test = testRunner.test;
export const before = testRunner.before;
export const after = testRunner.after;
export const beforeEach = testRunner.beforeEach;
export const afterEach = testRunner.afterEach;
export const mock = testRunner.mock;
export const waitFor = testRunner.waitFor;
export type TestContext = any;
