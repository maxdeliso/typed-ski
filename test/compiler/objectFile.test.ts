import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deserializeTripCObject,
  serializeTripCObject,
  type TripCObject,
} from "../../lib/compiler/objectFile.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";

test("objectFile serialization and validation", async (t) => {
  const validObject: TripCObject = {
    module: "M",
    exports: ["main"],
    imports: [{ name: "x", from: "Prelude" }],
    definitions: {
      main: {
        kind: "poly",
        name: "main",
        term: { kind: "systemF-var", name: "x" },
      },
    },
    dataDefinitions: [],
  };

  await t.test("round-trips a valid object file", () => {
    const json = serializeTripCObject(validObject);
    const parsed = deserializeTripCObject(json);
    assert.deepEqual(parsed, validObject);
  });

  await t.test("serializes and revives bigint payloads", () => {
    const withBigint: TripCObject = {
      ...validObject,
      definitions: {
        main: {
          kind: "poly",
          name: "main",
          term: {
            kind: "systemF-var",
            name: "x",
          },
          bigintMeta: 123n,
        } as unknown as TripLangTerm,
      },
    };

    const json = serializeTripCObject(withBigint);
    const parsed = deserializeTripCObject(json);
    const revived = parsed.definitions.main as unknown as {
      bigintMeta: unknown;
    };
    assert.deepEqual(typeof revived.bigintMeta, "bigint");
    assert.deepEqual(revived.bigintMeta, 123n);
  });

  await t.test("serializes equivalent nested objects canonically", () => {
    const a: TripCObject = {
      ...validObject,
      definitions: {
        main: {
          name: "main",
          term: {
            name: "x",
            kind: "systemF-var",
          },
          kind: "poly",
        } as TripLangTerm,
      },
    };
    const b: TripCObject = {
      ...validObject,
      definitions: {
        main: {
          kind: "poly",
          term: {
            kind: "systemF-var",
            name: "x",
          },
          name: "main",
        } as TripLangTerm,
      },
    };

    assert.deepEqual(serializeTripCObject(a), serializeTripCObject(b));
  });

  await t.test("throws on invalid JSON", () => {
    assert.throws(
      () => deserializeTripCObject("{invalid json"),
      Error,
      "Invalid JSON in object file",
    );
  });

  await t.test("throws on invalid bigint encoding", () => {
    const invalidBigint = JSON.stringify({
      module: "M",
      exports: [],
      imports: [],
      definitions: {
        main: { __trip_bigint__: 123 },
      },
      dataDefinitions: [],
    });

    assert.throws(
      () => deserializeTripCObject(invalidBigint),
      Error,
      "Invalid bigint encoding in object file",
    );
  });

  await t.test("validates required top-level fields", () => {
    assert.throws(
      () =>
        deserializeTripCObject(JSON.stringify({ ...validObject, module: 1 })),
      Error,
      "missing or invalid module name",
    );
    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, exports: "x" }),
        ),
      Error,
      "exports must be an array",
    );
    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, imports: "x" }),
        ),
      Error,
      "imports must be an array",
    );
    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, definitions: null }),
        ),
      Error,
      "definitions must be an object",
    );
    assert.throws(
      () => {
        const withoutDataDefinitions = JSON.parse(
          JSON.stringify(validObject),
        ) as Record<string, unknown>;
        delete withoutDataDefinitions.dataDefinitions;
        deserializeTripCObject(JSON.stringify(withoutDataDefinitions));
      },
      Error,
      "dataDefinitions must be an array",
    );
    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, dataDefinitions: "x" }),
        ),
      Error,
      "dataDefinitions must be an array",
    );
  });

  await t.test("validates import entries", () => {
    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            imports: [{ name: 1, from: "Prelude" }],
          }),
        ),
      Error,
      "import entries must have name and from strings",
    );
  });

  await t.test("validates data definition metadata", () => {
    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [123],
          }),
        ),
      Error,
      "each data definition must contain kind/name/typeParams/constructors",
    );

    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [
              {
                kind: "data",
                name: "Maybe",
                typeParams: [123],
                constructors: [],
              },
            ],
          }),
        ),
      Error,
      "typeParams must be strings",
    );

    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [
              {
                kind: "data",
                name: "Maybe",
                typeParams: [],
                constructors: [{ name: 123, fields: [] }],
              },
            ],
          }),
        ),
      Error,
      "data constructors must have name and fields",
    );

    assert.throws(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [
              {
                kind: "data",
                name: "Maybe",
                typeParams: [],
                constructors: [{ name: "Some", fields: "bad" }],
              },
            ],
          }),
        ),
      Error,
      "data constructors must have name and fields",
    );
  });
});
