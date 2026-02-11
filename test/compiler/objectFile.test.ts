import { assertEquals, assertThrows } from "std/assert";
import {
  deserializeTripCObject,
  serializeTripCObject,
  type TripCObject,
} from "../../lib/compiler/objectFile.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";

Deno.test("objectFile serialization and validation", async (t) => {
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

  await t.step("round-trips a valid object file", () => {
    const json = serializeTripCObject(validObject);
    const parsed = deserializeTripCObject(json);
    assertEquals(parsed, validObject);
  });

  await t.step("serializes and revives bigint payloads", () => {
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
    assertEquals(typeof revived.bigintMeta, "bigint");
    assertEquals(revived.bigintMeta, 123n);
  });

  await t.step("throws on invalid JSON", () => {
    assertThrows(
      () => deserializeTripCObject("{invalid json"),
      Error,
      "Invalid JSON in object file",
    );
  });

  await t.step("throws on invalid bigint encoding", () => {
    const invalidBigint = JSON.stringify({
      module: "M",
      exports: [],
      imports: [],
      definitions: {
        main: { __trip_bigint__: 123 },
      },
      dataDefinitions: [],
    });

    assertThrows(
      () => deserializeTripCObject(invalidBigint),
      Error,
      "Invalid bigint encoding in object file",
    );
  });

  await t.step("validates required top-level fields", () => {
    assertThrows(
      () =>
        deserializeTripCObject(JSON.stringify({ ...validObject, module: 1 })),
      Error,
      "missing or invalid module name",
    );
    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, exports: "x" }),
        ),
      Error,
      "exports must be an array",
    );
    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, imports: "x" }),
        ),
      Error,
      "imports must be an array",
    );
    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, definitions: null }),
        ),
      Error,
      "definitions must be an object",
    );
    assertThrows(
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
    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({ ...validObject, dataDefinitions: "x" }),
        ),
      Error,
      "dataDefinitions must be an array",
    );
  });

  await t.step("validates import entries", () => {
    assertThrows(
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

  await t.step("validates data definition metadata", () => {
    assertThrows(
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

    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [{
              kind: "data",
              name: "Maybe",
              typeParams: [123],
              constructors: [],
            }],
          }),
        ),
      Error,
      "typeParams must be strings",
    );

    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [{
              kind: "data",
              name: "Maybe",
              typeParams: [],
              constructors: [{ name: 123, fields: [] }],
            }],
          }),
        ),
      Error,
      "data constructors must have name and fields",
    );

    assertThrows(
      () =>
        deserializeTripCObject(
          JSON.stringify({
            ...validObject,
            dataDefinitions: [{
              kind: "data",
              name: "Maybe",
              typeParams: [],
              constructors: [{ name: "Some", fields: "bad" }],
            }],
          }),
        ),
      Error,
      "data constructors must have name and fields",
    );
  });
});
