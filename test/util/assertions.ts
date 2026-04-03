import assertStrict from "node:assert/strict";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasProperty(value: unknown, property: PropertyKey): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.hasOwn(value, property) || property in value)
  );
}

function assertIncludes(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (typeof actual === "string") {
    assertStrict.ok(actual.includes(String(expected)), message);
    return;
  }
  if (Array.isArray(actual)) {
    assertStrict.ok(actual.includes(expected), message);
    return;
  }
  if (actual instanceof Set || actual instanceof Map) {
    assertStrict.ok(actual.has(expected), message);
    return;
  }
  if (ArrayBuffer.isView(actual) && "includes" in actual) {
    assertStrict.ok(
      (actual as Uint8Array | Int32Array).includes(expected as number),
      message,
    );
    return;
  }

  throw new TypeError(`Unsupported include target: ${typeof actual}`);
}

function assertNotIncludes(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (typeof actual === "string") {
    assertStrict.ok(!actual.includes(String(expected)), message);
    return;
  }
  if (Array.isArray(actual)) {
    assertStrict.ok(!actual.includes(expected), message);
    return;
  }
  if (actual instanceof Set || actual instanceof Map) {
    assertStrict.ok(!actual.has(expected), message);
    return;
  }
  if (ArrayBuffer.isView(actual) && "includes" in actual) {
    assertStrict.ok(
      !(actual as Uint8Array | Int32Array).includes(expected as number),
      message,
    );
    return;
  }

  throw new TypeError(`Unsupported include target: ${typeof actual}`);
}

function assertType(actual: unknown, expectedType: string): void {
  switch (expectedType) {
    case "array":
      assertStrict.ok(Array.isArray(actual));
      return;
    case "object":
      assertStrict.equal(typeof actual, "object");
      assertStrict.notEqual(actual, null);
      assertStrict.ok(!Array.isArray(actual));
      return;
    default:
      assertStrict.equal(typeof actual, expectedType);
  }
}

function assertHasProperty(
  actual: unknown,
  property: PropertyKey,
  expectedValue?: unknown,
): void {
  assertStrict.ok(
    hasProperty(actual, property),
    `Expected property ${String(property)} to exist`,
  );

  if (arguments.length >= 3) {
    assertStrict.deepStrictEqual(
      (actual as Record<PropertyKey, unknown>)[property],
      expectedValue,
    );
  }
}

function assertLength(actual: unknown, expectedLength: number): void {
  assertStrict.ok(
    actual !== null &&
      actual !== undefined &&
      typeof (actual as { length?: unknown }).length === "number",
    "Expected value with a numeric length property",
  );
  assertStrict.equal((actual as { length: number }).length, expectedLength);
}

function createThrowMatcher(
  expected?: unknown,
  expectedMessage?: RegExp | string,
): Parameters<typeof assertStrict.throws>[1] | undefined {
  if (expected === undefined && expectedMessage === undefined) {
    return undefined;
  }

  if (expectedMessage !== undefined) {
    return (error: unknown) => {
      if (typeof expected === "function") {
        assertStrict.ok(error instanceof expected);
      } else if (expected instanceof RegExp) {
        assertStrict.match(errorMessage(error), expected);
      } else if (typeof expected === "string") {
        assertStrict.ok(errorMessage(error).includes(expected));
      }

      if (expectedMessage instanceof RegExp) {
        assertStrict.match(errorMessage(error), expectedMessage);
      } else {
        assertStrict.ok(errorMessage(error).includes(expectedMessage));
      }
      return true;
    };
  }

  if (expected instanceof RegExp) {
    return expected;
  }
  if (typeof expected === "function") {
    return expected as Parameters<typeof assertStrict.throws>[1];
  }
  if (typeof expected === "string") {
    return (error: unknown) => {
      assertStrict.ok(errorMessage(error).includes(expected));
      return true;
    };
  }

  return undefined;
}

type ExpectChain = {
  to: {
    equal: (expected: unknown, message?: string) => void;
    include: (expected: unknown, message?: string) => void;
    contain: (expected: unknown, message?: string) => void;
    match: (expected: RegExp, message?: string) => void;
    satisfy: (predicate: (actual: any) => boolean) => void;
    throw: (expected?: unknown, expectedMessage?: RegExp | string) => void;
    readonly exist: true;
    deep: {
      equal: (expected: unknown, message?: string) => void;
    };
    have: {
      property: (
        property: PropertyKey,
        expectedValue?: unknown,
        message?: string,
      ) => void;
      length: (expectedLength: number, message?: string) => void;
      lengthOf: (expectedLength: number, message?: string) => void;
    };
    be: {
      readonly ok: true;
      readonly true: true;
      readonly false: true;
      readonly null: true;
      readonly undefined: true;
      readonly empty: true;
      a: ExpectTypeFunction;
      an: ExpectTypeFunction;
      greaterThan: (expected: number | bigint) => void;
      lessThan: (expected: number | bigint) => void;
    };
    not: {
      equal: (expected: unknown, message?: string) => void;
      throw: () => void;
      be: {
        readonly null: true;
        readonly undefined: true;
      };
    };
  };
  not: ExpectChain["to"]["not"] & { to: ExpectChain["to"]["not"] };
};
type ExpectTypeFunction = ((expectedType: string, message?: string) => void) & {
  instanceof: (
    expectedType: abstract new (...args: never[]) => unknown,
    message?: string,
  ) => void;
};

type ExpectFn = {
  <T>(actual: T, message?: string): ExpectChain;
  fail: (message?: string) => never;
};

function buildExpectation<T>(actual: T, message?: string): ExpectChain {
  const typeAssertion = Object.assign(
    (expectedType: string, overrideMessage?: string) => {
      assertType(actual, expectedType);
      if (overrideMessage) {
        assertStrict.ok(true, overrideMessage);
      }
    },
    {
      instanceof: (
        expectedType: abstract new (...args: never[]) => unknown,
        overrideMessage?: string,
      ) => {
        assertStrict.ok(
          actual instanceof expectedType,
          overrideMessage ?? message,
        );
      },
    },
  ) as ExpectTypeFunction;

  const be = {
    a: typeAssertion,
    an: typeAssertion,
    greaterThan: (expected: number | bigint) => {
      assertStrict.ok((actual as number | bigint) > expected, message);
    },
    lessThan: (expected: number | bigint) => {
      assertStrict.ok((actual as number | bigint) < expected, message);
    },
  } as ExpectChain["to"]["be"];
  Object.defineProperties(be, {
    ok: {
      get() {
        assertStrict.ok(actual, message);
        return true;
      },
    },
    true: {
      get() {
        assertStrict.equal(actual, true, message);
        return true;
      },
    },
    false: {
      get() {
        assertStrict.equal(actual, false, message);
        return true;
      },
    },
    null: {
      get() {
        assertStrict.equal(actual, null, message);
        return true;
      },
    },
    undefined: {
      get() {
        assertStrict.equal(actual, undefined, message);
        return true;
      },
    },
    empty: {
      get() {
        assertLength(actual, 0);
        return true;
      },
    },
  });

  const notBe = {} as ExpectChain["to"]["not"]["be"];
  Object.defineProperties(notBe, {
    null: {
      get() {
        assertStrict.notEqual(actual, null, message);
        return true;
      },
    },
    undefined: {
      get() {
        assertStrict.notEqual(actual, undefined, message);
        return true;
      },
    },
  });

  const not = {
    equal: (expected: unknown, overrideMessage?: string) => {
      assertStrict.notEqual(actual, expected, overrideMessage ?? message);
    },
    throw: () => {
      assertStrict.doesNotThrow(
        actual as Parameters<typeof assertStrict.doesNotThrow>[0],
      );
    },
    be: notBe,
  } as ExpectChain["to"]["not"] & { to: ExpectChain["to"]["not"] };
  not.to = not;

  return {
    to: {
      equal: (expected: unknown, overrideMessage?: string) => {
        assertStrict.equal(actual, expected, overrideMessage ?? message);
      },
      include: (expected: unknown, overrideMessage?: string) => {
        assertIncludes(actual, expected, overrideMessage ?? message);
      },
      contain: (expected: unknown, overrideMessage?: string) => {
        assertIncludes(actual, expected, overrideMessage ?? message);
      },
      match: (expected: RegExp, overrideMessage?: string) => {
        assertStrict.match(
          String(actual),
          expected,
          overrideMessage ?? message,
        );
      },
      satisfy: (predicate: (actual: T) => boolean) => {
        assertStrict.ok(predicate(actual), message);
      },
      throw: (expected?: unknown, expectedMessage?: RegExp | string) => {
        const matcher = createThrowMatcher(expected, expectedMessage);
        if (matcher === undefined) {
          assertStrict.throws(
            actual as Parameters<typeof assertStrict.throws>[0],
          );
          return;
        }
        assertStrict.throws(
          actual as Parameters<typeof assertStrict.throws>[0],
          matcher,
        );
      },
      get exist(): true {
        assertStrict.notEqual(actual, undefined, message);
        assertStrict.notEqual(actual, null, message);
        return true;
      },
      deep: {
        equal: (expected: unknown, overrideMessage?: string) => {
          assertStrict.deepStrictEqual(
            actual,
            expected,
            overrideMessage ?? message,
          );
        },
      },
      have: {
        property(
          property: PropertyKey,
          expectedValue?: unknown,
          _overrideMessage?: string,
        ) {
          if (arguments.length === 1) {
            assertHasProperty(actual, property);
            return;
          }
          assertHasProperty(actual, property, expectedValue);
        },
        length: (expectedLength: number, _overrideMessage?: string) => {
          assertLength(actual, expectedLength);
        },
        lengthOf: (expectedLength: number, _overrideMessage?: string) => {
          assertLength(actual, expectedLength);
        },
      },
      be,
      not,
    },
    not,
  };
}

export const expect: ExpectFn = Object.assign(
  <T>(actual: T, message?: string) => buildExpectation(actual, message),
  {
    fail(message?: string): never {
      return assertStrict.fail(message);
    },
  },
);

type AssertCompat = {
  equal: typeof assertStrict.equal;
  strictEqual: typeof assertStrict.strictEqual;
  notEqual: typeof assertStrict.notEqual;
  notStrictEqual: typeof assertStrict.notStrictEqual;
  deepEqual: typeof assertStrict.deepEqual;
  deepStrictEqual: typeof assertStrict.deepStrictEqual;
  notDeepEqual: typeof assertStrict.notDeepEqual;
  ok: typeof assertStrict.ok;
  fail: typeof assertStrict.fail;
  match: typeof assertStrict.match;
  throws: typeof assertStrict.throws;
  rejects: typeof assertStrict.rejects;
  include: typeof assertIncludes;
  notInclude: typeof assertNotIncludes;
  property: typeof assertHasProperty;
  isDefined<T>(value: T, message?: string): asserts value is NonNullable<T>;
  isUndefined(value: unknown, message?: string): void;
  isTrue(value: unknown, message?: string): void;
};

export const assert: AssertCompat = {
  equal: assertStrict.equal,
  strictEqual: assertStrict.strictEqual,
  notEqual: assertStrict.notEqual,
  notStrictEqual: assertStrict.notStrictEqual,
  deepEqual: assertStrict.deepEqual,
  deepStrictEqual: assertStrict.deepStrictEqual,
  notDeepEqual: assertStrict.notDeepEqual,
  ok: assertStrict.ok,
  fail: assertStrict.fail,
  match: assertStrict.match,
  throws: assertStrict.throws,
  rejects: assertStrict.rejects,
  include: assertIncludes,
  notInclude: assertNotIncludes,
  property: assertHasProperty,
  isDefined<T>(value: T, message?: string): asserts value is NonNullable<T> {
    assertStrict.notEqual(value, undefined, message);
    assertStrict.notEqual(value, null, message);
  },
  isUndefined(value: unknown, message?: string): void {
    assertStrict.equal(value, undefined, message);
  },
  isTrue(value: unknown, message?: string): void {
    assertStrict.equal(value, true, message);
  },
};
