/**
 * Tests for Rust struct parser
 *
 * Tests various edge cases to ensure the parser is robust, including
 * basic structs, attributes, comments, generic types, and real-world examples.
 *
 * @module
 */

import { assertEquals, assertExists } from "std/assert";
import { ParseError } from "../../lib/parser/parseError.ts";
import {
  parseRustStruct,
  type StructField,
} from "../../lib/parser/rustStruct.ts";

Deno.test("parseRustStruct", async (t) => {
  await t.step("should parse basic struct with simple fields", () => {
    const source = `
struct TestStruct {
    field1: u32,
    field2: String,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.name, "TestStruct");
    assertEquals(result.fields.length, 2);
    assertEquals(result.fields[0].name, "field1");
    assertEquals(result.fields[0].type, "u32");
    assertEquals(result.fields[1].name, "field2");
    assertEquals(result.fields[1].type, "String");
  });

  await t.step("should parse struct with attributes and comments", () => {
    const source = `
#[repr(C, align(64))]
struct TestStruct {
    // This is a line comment
    field1: u32,
    /* This is a block comment */
    field2: String,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
    assertEquals(result.fields[0].name, "field1");
    assertEquals(result.fields[1].name, "field2");
  });

  await t.step("should parse struct with generic types", () => {
    const source = `
struct TestStruct {
    field1: AtomicU32,
    field2: Vec<String>,
    field3: Option<Result<u32, Error>>,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 3);
    assertEquals(result.fields[0].name, "field1");
    assertEquals(result.fields[0].type, "AtomicU32");
    assertEquals(result.fields[1].name, "field2");
    assertEquals(result.fields[1].type, "Vec<String>");
    assertEquals(result.fields[2].name, "field3");
    assertEquals(result.fields[2].type, "Option<Result<u32, Error>>");
  });

  await t.step("should parse struct with field attributes", () => {
    const source = `
struct TestStruct {
    #[serde(rename = "field_one")]
    field1: u32,
    #[cfg(feature = "test")]
    field2: String,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
    assertEquals(result.fields[0].name, "field1");
    assertEquals(result.fields[1].name, "field2");
  });

  await t.step(
    "should parse real SabHeader structure from arena.rs",
    async () => {
      const rustFile = await Deno.readTextFile("rust/src/arena.rs");
      const result = parseRustStruct(rustFile, "SabHeader");

      assertEquals(result.name, "SabHeader");
      assertEquals(result.fields.length, 17);

      // Verify first and last fields
      assertEquals(result.fields[0].name, "magic");
      assertEquals(result.fields[0].type, "u32");
      assertEquals(result.fields[result.fields.length - 1].name, "top");
      assertEquals(result.fields[result.fields.length - 1].type, "AtomicU32");

      // Verify expected critical fields exist
      const fieldNames = result.fields.map((f: StructField) => f.name);
      const expectedFields = ["magic", "ring_entries", "capacity", "top"];
      for (const expected of expectedFields) {
        assertExists(
          fieldNames.find((name) => name === expected),
          `Missing expected field: ${expected}`,
        );
      }
    },
  );

  await t.step("should handle struct with trailing comma", () => {
    const source = `
struct TestStruct {
    field1: u32,
    field2: String,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
  });

  await t.step("should handle struct without trailing comma", () => {
    const source = `
struct TestStruct {
    field1: u32,
    field2: String
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
  });

  await t.step("should throw ParseError for non-existent struct", () => {
    const source = `
struct OtherStruct {
    field1: u32,
}
`;

    let error: Error | null = null;
    try {
      parseRustStruct(source, "NonExistentStruct");
    } catch (e) {
      error = e as Error;
    }

    assertExists(error);
    assertEquals(error instanceof ParseError, true);
  });

  await t.step("should handle nested generic types", () => {
    const source = `
struct TestStruct {
    field1: HashMap<String, Vec<Option<u32>>>,
    field2: Result<Vec<u8>, Box<dyn Error>>,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
    assertEquals(
      result.fields[0].type,
      "HashMap<String, Vec<Option<u32>>>",
    );
    assertEquals(
      result.fields[1].type,
      "Result<Vec<u8>, Box<dyn Error>>",
    );
  });

  await t.step("should handle tuple types", () => {
    const source = `
struct TestStruct {
    field1: (u32, String),
    field2: (i32, f64, bool),
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
    assertEquals(result.fields[0].type, "(u32, String)");
    assertEquals(result.fields[1].type, "(i32, f64, bool)");
  });

  await t.step("should handle mixed comments and attributes", () => {
    const source = `
// Struct comment
#[repr(C)]
struct TestStruct {
    // Field comment
    #[serde(skip)]
    field1: u32, // Inline comment
    /* Block comment */
    field2: String,
}
`;

    const result = parseRustStruct(source, "TestStruct");

    assertEquals(result.fields.length, 2);
    assertEquals(result.fields[0].name, "field1");
    assertEquals(result.fields[1].name, "field2");
  });
});
