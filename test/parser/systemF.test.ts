import { strict as assert } from "node:assert";
import { parseSystemF, unparseSystemF } from "../../lib/parser/systemFTerm.ts";

Deno.test("System F Parser", async (t) => {
  await t.step("parses a single variable", () => {
    const input = "x";
    const [lit, ast] = parseSystemF(input);
    // Expect the literal string to match the input.
    assert.equal(lit, "x");
    // The AST should be a variable node.
    assert.equal(ast.kind, "systemF-var");
    assert.equal(ast.name, "x");
  });

  await t.step("parses a natural number literal", () => {
    const [lit, ast] = parseSystemF("123");
    assert.equal(lit, "123");
    assert.equal(ast.kind, "systemF-var");
    assert.match(ast.name, /__trip_nat_literal__/);
    assert.equal(unparseSystemF(ast), "123");
  });

  await t.step("parses a term abstraction", () => {
    // Example: \x:X=>x
    const input = "\\x:X=>x";
    const [lit, ast] = parseSystemF(input);
    assert.equal(lit, "\\x:X=>x");

    // The AST should be a term abstraction.
    assert.equal(ast.kind, "systemF-abs");
    assert.equal(ast.name, "x");

    // The type annotation should be a type variable "X".
    const tyAnnot = ast.typeAnnotation;
    assert.equal(tyAnnot.kind, "type-var");
    assert.equal(tyAnnot.typeName, "X");

    // The body should be the variable "x".
    const body = ast.body;
    assert.equal(body.kind, "systemF-var");
    assert.equal(body.name, "x");
  });

  await t.step("parses a type abstraction", () => {
    // Example: #X=>\x:X=>x
    const input = "#X=>\\x:X=>x";
    const [lit, ast] = parseSystemF(input);
    assert.equal(lit, "#X=>\\x:X=>x");
    // The AST should be a type abstraction.
    assert.equal(ast.kind, "systemF-type-abs");
    assert.equal(ast.typeVar, "X");

    // Its body should be a term abstraction.
    const body = ast.body;
    assert.equal(body.kind, "systemF-abs");
    assert.equal(body.name, "x");
    assert.equal(body.typeAnnotation.kind, "type-var");
    assert.equal(body.typeAnnotation.typeName, "X");
    assert.equal(body.body.kind, "systemF-var");
    assert.equal(body.body.name, "x");
  });

  await t.step("parses a term with type application", () => {
    // Example: x[#Y->Y->Y]
    // This applies variable x to a type argument which is a universal type.
    const input = "x[#Y->Y->Y]";
    const [lit, ast] = parseSystemF(input);
    assert.equal(lit, "x[#Y->Y->Y]");

    // The AST should be a type application node.
    assert.equal(ast.kind, "systemF-type-app");

    // The term part should be a variable "x".
    const term = ast.term;
    assert.equal(term.kind, "systemF-var");
    assert.equal(term.name, "x");

    // The type argument should be a universal type.
    const typeArg = ast.typeArg;
    assert.equal(typeArg.kind, "forall");
    assert.equal(typeArg.typeVar, "Y");

    // The body of the forall is an arrow type (a cons cell) representing Y->Y.
    assert.equal(typeArg.body.kind, "non-terminal");
    const left = typeArg.body.lft;
    const right = typeArg.body.rgt;
    assert.equal(left.kind, "type-var");
    assert.equal(left.typeName, "Y");
    assert.equal(right.kind, "type-var");
    assert.equal(right.typeName, "Y");
  });

  await t.step("parses left-associative term applications", () => {
    // Example: x y z
    // This should be parsed as ((x y) z)
    const input = "x y z";
    const [lit, ast] = parseSystemF(input);

    // Expect the literal to be "x y z" (or equivalent).
    assert.equal(lit, "x y z");

    // The outermost AST node for application is a cons cell.
    assert.equal(ast.kind, "non-terminal");

    // Its left branch should also be a cons cell representing (x y).
    const inner = ast.lft;
    assert.equal(inner.kind, "non-terminal");

    // The left branch of the inner cons cell should be the variable "x".
    assert.equal(inner.lft.kind, "systemF-var");
    assert.equal(inner.lft.name, "x");

    // The right branch of the inner cons cell should be the variable "y".
    assert.equal(inner.rgt.kind, "systemF-var");
    assert.equal(inner.rgt.name, "y");

    // The right branch of the outer cons cell should be the variable "z".
    assert.equal(ast.rgt.kind, "systemF-var");
    assert.equal(ast.rgt.name, "z");
  });

  await t.step("rejects purely numeric identifiers in lambda bindings", () => {
    // Purely numeric strings should be parsed as numeric literals, not identifiers
    // This test verifies that lambda abstractions with numeric bindings are rejected
    assert.throws(
      () => {
        parseSystemF("\\123:X=>123");
      },
      Error,
      "not a valid identifier",
    );
  });

  await t.step("throws an error on incomplete or malformed input", () => {
    const badInputs = [
      "(", // missing closing parenthesis
      "\\x:X", // missing fat arrow and body
      "x)", // unmatched closing parenthesis
      "x y )", // stray parenthesis at end
      "#X X", // missing fat arrow after #X
    ];
    badInputs.forEach((input) => {
      assert.throws(
        () => {
          parseSystemF(input);
        },
        Error,
        `Expected an error for input: ${input}`,
      );
    });
  });

  await t.step(
    "round-trips a well-formed expression through pretty printer and parser",
    () => {
      // Use a well–formed expression (here the polymorphic identity)
      const input = "#X=> \\x: X => x";
      // Parse the input to get its AST.
      const [, ast] = parseSystemF(input);
      // Pretty–print the AST to obtain a normalized string.
      const pretty = unparseSystemF(ast);

      // Now re-parse the pretty printed output.
      const [roundTripLit, roundTripAst] = parseSystemF(pretty);

      // Compare the literal strings (ignoring whitespace).
      assert.equal(
        roundTripLit.replace(/\s+/g, ""),
        pretty.replace(/\s+/g, ""),
        "Round-tripped literal should match pretty printed output (modulo whitespace)",
      );

      const prettyRoundTrip = unparseSystemF(roundTripAst);
      assert.equal(
        prettyRoundTrip.replace(/\s+/g, ""),
        pretty.replace(/\s+/g, ""),
        "Pretty printed round-trip AST should match original pretty printed output (modulo whitespace)",
      );
    },
  );

  await t.step(
    "parseAtomicSystemFTermNoTypeApp - match scrutinees",
    async (t) => {
      await t.step("parses lambda abstraction as match scrutinee", () => {
        // Example: match (\x:X=>x) [T] { | None => y }
        const input = "match (\\x:X=>x) [T] { | None => y }";
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");

        // The scrutinee should be a lambda abstraction
        const scrutinee = ast.scrutinee;
        assert.equal(scrutinee.kind, "systemF-abs");
        assert.equal(scrutinee.name, "x");
        assert.equal(scrutinee.typeAnnotation.kind, "type-var");
        assert.equal(scrutinee.typeAnnotation.typeName, "X");
        assert.equal(scrutinee.body.kind, "systemF-var");
        assert.equal(scrutinee.body.name, "x");
      });

      await t.step("parses parenthesized term as match scrutinee", () => {
        // Example: match (x y) [T] { | None => z }
        const input = "match (x y) [T] { | None => z }";
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");

        // The scrutinee should be a parenthesized application
        const scrutinee = ast.scrutinee;
        assert.equal(scrutinee.kind, "non-terminal");
        assert.equal(scrutinee.lft.kind, "systemF-var");
        assert.equal(scrutinee.lft.name, "x");
        assert.equal(scrutinee.rgt.kind, "systemF-var");
        assert.equal(scrutinee.rgt.name, "y");
      });

      await t.step("parses type abstraction as match scrutinee", () => {
        // Example: match (#X=>x) [T] { | None => y }
        const input = "match (#X=>x) [T] { | None => y }";
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");

        // The scrutinee should be a type abstraction
        const scrutinee = ast.scrutinee;
        assert.equal(scrutinee.kind, "systemF-type-abs");
        assert.equal(scrutinee.typeVar, "X");
        assert.equal(scrutinee.body.kind, "systemF-var");
        assert.equal(scrutinee.body.name, "x");
      });

      await t.step("parses numeric literal as match scrutinee", () => {
        // Example: match 123 [T] { | None => y }
        const input = "match 123 [T] { | None => y }";
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");

        // The scrutinee should be a numeric literal variable
        const scrutinee = ast.scrutinee;
        assert.equal(scrutinee.kind, "systemF-var");
        assert.match(scrutinee.name, /__trip_nat_literal__/);
        assert.equal(unparseSystemF(scrutinee), "123");
      });

      await t.step(
        "parses nested parenthesized term as match scrutinee",
        () => {
          // Example: match ((x)) [T] { | None => y }
          const input = "match ((x)) [T] { | None => y }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          // The scrutinee should be a variable (double parentheses)
          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-var");
          assert.equal(scrutinee.name, "x");
        },
      );

      await t.step(
        "parses complex parenthesized expression as match scrutinee",
        () => {
          // Example: match ((\x:X=>x) y) [T] { | None => z }
          const input = "match ((\\x:X=>x) y) [T] { | None => z }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          // The scrutinee should be an application of a lambda to y
          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "non-terminal");
          assert.equal(scrutinee.lft.kind, "systemF-abs");
          assert.equal(scrutinee.lft.name, "x");
          assert.equal(scrutinee.rgt.kind, "systemF-var");
          assert.equal(scrutinee.rgt.name, "y");
        },
      );
    },
  );

  await t.step("match parsing error cases", async (t) => {
    await t.step(
      "should throw error when match requires explicit return type",
      () => {
        assert.throws(
          () => {
            parseSystemF("match x { | None => y }");
          },
          Error,
          "match requires an explicit return type",
        );
      },
    );

    await t.step(
      "should throw error when expected | to start match arm",
      () => {
        assert.throws(
          () => {
            parseSystemF("match x [T] { None => y }");
          },
          Error,
          "expected '|' to start match arm",
        );
      },
    );

    await t.step("should throw error for empty match arm", () => {
      assert.throws(
        () => {
          parseSystemF("match x [T] { | None => }");
        },
        Error,
        "match arm requires a body",
      );
    });

    await t.step("should throw error when match has no arms", () => {
      assert.throws(
        () => {
          parseSystemF("match x [T] { }");
        },
        Error,
        "match must declare at least one arm",
      );
    });

    await t.step("should throw error for multiple arrow case", () => {
      assert.throws(
        () => {
          parseSystemF("match x [T] { | None => => y }");
        },
        Error,
        "multiple arrow case",
      );
    });
  });
});
