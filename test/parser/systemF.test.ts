import { strict as assert } from "node:assert";
import { parseSystemF, unparseSystemF } from "../../lib/parser/systemFTerm.ts";
import {
  parseSystemFType,
  unparseSystemFType,
} from "../../lib/parser/systemFType.ts";
import { parseWithEOF } from "../../lib/parser/eof.ts";
import { parseNatLiteralIdentifier } from "../../lib/consts/natNames.ts";
import type { SystemFTerm } from "../../lib/terms/systemF.ts";
import { flattenSystemFApp } from "../../lib/terms/systemF.ts";
import {
  arrow,
  mkTypeVariable,
  typeApp,
  typesLitEq,
} from "../../lib/types/types.ts";

const assertNatLiteral = (term: SystemFTerm, expected: bigint) => {
  assert.equal(term.kind, "systemF-var");
  const value = parseNatLiteralIdentifier(term.name);
  assert.equal(value, expected);
};

const assertNatList = (term: SystemFTerm, expected: bigint[]) => {
  let current = term;
  for (const value of expected) {
    assert.equal(current.kind, "non-terminal");
    const consApp = current.lft;
    assert.equal(consApp.kind, "non-terminal");
    const consTypeApp = consApp.lft;
    assert.equal(consTypeApp.kind, "systemF-type-app");
    assert.equal(consTypeApp.term.kind, "systemF-var");
    assert.equal(consTypeApp.term.name, "cons");
    assert.equal(consTypeApp.typeArg.kind, "type-var");
    assert.equal(consTypeApp.typeArg.typeName, "Nat");
    assertNatLiteral(consApp.rgt, value);
    current = current.rgt;
  }
  assert.equal(current.kind, "systemF-type-app");
  assert.equal(current.term.kind, "systemF-var");
  assert.equal(current.term.name, "nil");
  assert.equal(current.typeArg.kind, "type-var");
  assert.equal(current.typeArg.typeName, "Nat");
};

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

  await t.step("parses a character literal", () => {
    const [lit, ast] = parseSystemF("'a'");
    assert.equal(lit, "'a'");
    assertNatLiteral(ast, 97n);
    assert.equal(unparseSystemF(ast), "97");
  });

  await t.step("parses escaped character literals", () => {
    const cases: Array<[string, bigint]> = [
      ["'\\n'", 10n],
      ["'\\\\'", 92n],
      ["'\\''", 39n],
      ["'\\\"'", 34n],
    ];
    for (const [input, expected] of cases) {
      const [lit, ast] = parseSystemF(input);
      assert.equal(lit, input);
      assertNatLiteral(ast, expected);
    }
  });

  await t.step("rejects malformed character literals", () => {
    const badInputs = [
      "''",
      "'a",
      "'ab'",
      "'\n'",
      "'\\t'",
      "'\\x'",
      "'\\u'",
      "'\\0'",
    ];
    for (const input of badInputs) {
      assert.throws(() => parseSystemF(input), Error);
    }
  });

  await t.step("rejects non-printable character literals", () => {
    assert.throws(() => parseSystemF("'\u0001'"), Error);
    assert.throws(() => parseSystemF("'\u001F'"), Error);
  });

  await t.step("parses a string literal into a Nat list", () => {
    const [lit, ast] = parseSystemF('"ab"');
    assert.equal(lit, '"ab"');
    assertNatList(ast, [97n, 98n]);
  });

  await t.step("parses string literal escapes", () => {
    const [lit, ast] = parseSystemF('"a\\n\\"\\\\"');
    assert.equal(lit, '"a\\n\\"\\\\"');
    assertNatList(ast, [97n, 10n, 34n, 92n]);
  });

  await t.step("parses empty string literal", () => {
    const [lit, ast] = parseSystemF('""');
    assert.equal(lit, '""');
    assertNatList(ast, []);
  });

  await t.step("parses string literals in applications", () => {
    const [lit, ast] = parseSystemF('f "a"');
    assert.equal(lit, 'f "a"');
    assert.equal(ast.kind, "non-terminal");
    assert.equal(ast.lft.kind, "systemF-var");
    assert.equal(ast.lft.name, "f");
    assertNatList(ast.rgt, [97n]);
  });

  await t.step("rejects malformed string literals", () => {
    const badInputs = [
      '"unterminated',
      '"\\t"',
      '"\\x"',
      '"\\u"',
      '"\\0"',
    ];
    for (const input of badInputs) {
      assert.throws(() => parseSystemF(input), Error);
    }
  });

  await t.step("rejects non-printable string literals", () => {
    assert.throws(() => parseSystemF('"\u0001"'), Error);
    assert.throws(() => parseSystemF('"\u001F"'), Error);
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

  await t.step("let bindings", async (t) => {
    await t.step("parses let x = 1 in x (unannotated)", () => {
      const [lit, ast] = parseSystemF("let x = 1 in x");
      assert.equal(lit, "let x = 1 in x");
      assert.equal(ast.kind, "systemF-let");
      assert.equal(ast.name, "x");
      assert.equal(ast.value.kind, "systemF-var");
      assert.ok(parseNatLiteralIdentifier(ast.value.name) === 1n);
      assert.equal(ast.body.kind, "systemF-var");
      assert.equal(ast.body.name, "x");
    });

    await t.step(
      "parses let x : Nat = 1 in x (annotated, desugars to App(Abs(...), 1))",
      () => {
        const [lit, ast] = parseSystemF("let x : Nat = 1 in x");
        assert.equal(lit, "let x : Nat = 1 in x");
        assert.equal(ast.kind, "non-terminal");
        assert.equal(ast.lft.kind, "systemF-abs");
        assert.equal(ast.lft.name, "x");
        assert.equal(ast.lft.typeAnnotation.kind, "type-var");
        assert.equal(ast.lft.typeAnnotation.typeName, "Nat");
        assert.equal(ast.lft.body.kind, "systemF-var");
        assert.equal(ast.lft.body.name, "x");
        assert.equal(ast.rgt.kind, "systemF-var");
        assert.ok(parseNatLiteralIdentifier(ast.rgt.name) === 1n);
      },
    );

    await t.step("parses nested let bindings", () => {
      const [lit, ast] = parseSystemF("let x = 1 in let y = 2 in x");
      assert.equal(lit, "let x = 1 in let y = 2 in x");
      assert.equal(ast.kind, "systemF-let");
      assert.equal(ast.name, "x");
      assert.equal(ast.body.kind, "systemF-let");
      assert.equal(ast.body.name, "y");
      assert.equal(ast.body.body.kind, "systemF-var");
      assert.equal(ast.body.body.name, "x");
    });

    await t.step("missing 'in' triggers syntax error", () => {
      assert.throws(() => parseSystemF("let x = 1"), Error);
      assert.throws(() => parseSystemF("let x = 1 foo"), Error);
    });

    await t.step("missing '=' triggers syntax error", () => {
      assert.throws(() => parseSystemF("let x 1 in x"), Error);
      assert.throws(() => parseSystemF("let x in x"), Error);
    });

    await t.step("variable shadowing (inner let shadows outer)", () => {
      const [_, ast] = parseSystemF("let x = 1 in let x = 2 in x");
      assert.equal(ast.kind, "systemF-let");
      assert.equal(ast.name, "x");
      assert.equal(ast.body.kind, "systemF-let");
      assert.equal(ast.body.name, "x");
      assert.equal(ast.body.body.kind, "systemF-var");
      assert.equal(ast.body.body.name, "x"); // inner x refers to inner binding
    });
  });

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

      await t.step(
        "parses lambda abstraction with arrow type annotation as match scrutinee",
        () => {
          // Example: match (\f:X->Y=>f) [T] { | None => y }
          const input = "match (\\f:X->Y=>f) [T] { | None => y }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-abs");
          assert.equal(scrutinee.name, "f");
          assert.equal(scrutinee.typeAnnotation.kind, "non-terminal");
          assert.equal(scrutinee.typeAnnotation.lft.kind, "type-var");
          assert.equal(scrutinee.typeAnnotation.lft.typeName, "X");
          assert.equal(scrutinee.typeAnnotation.rgt.kind, "type-var");
          assert.equal(scrutinee.typeAnnotation.rgt.typeName, "Y");
        },
      );

      await t.step(
        "parses lambda abstraction with complex body as match scrutinee",
        () => {
          // Example: match (\x:X=>x y) [T] { | None => z }
          const input = "match (\\x:X=>x y) [T] { | None => z }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-abs");
          assert.equal(scrutinee.name, "x");
          assert.equal(scrutinee.body.kind, "non-terminal");
          assert.equal(scrutinee.body.lft.kind, "systemF-var");
          assert.equal(scrutinee.body.lft.name, "x");
          assert.equal(scrutinee.body.rgt.kind, "systemF-var");
          assert.equal(scrutinee.body.rgt.name, "y");
        },
      );

      await t.step(
        "parses nested lambda abstraction as match scrutinee",
        () => {
          // Example: match (\x:X=>\y:Y=>x) [T] { | None => z }
          const input = "match (\\x:X=>\\y:Y=>x) [T] { | None => z }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-abs");
          assert.equal(scrutinee.name, "x");
          assert.equal(scrutinee.body.kind, "systemF-abs");
          assert.equal(scrutinee.body.name, "y");
          assert.equal(scrutinee.body.body.kind, "systemF-var");
          assert.equal(scrutinee.body.body.name, "x");
        },
      );

      await t.step(
        "parses lambda abstraction with forall type annotation as match scrutinee",
        () => {
          // Example: match (\x:#Y->Y=>x) [T] { | None => y }
          const input = "match (\\x:#Y->Y=>x) [T] { | None => y }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-abs");
          assert.equal(scrutinee.name, "x");
          assert.equal(scrutinee.typeAnnotation.kind, "forall");
          assert.equal(scrutinee.typeAnnotation.typeVar, "Y");
        },
      );

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

      await t.step(
        "parses type abstraction with application body as match scrutinee",
        () => {
          // Example: match (#X=>x y) [T] { | None => z }
          const input = "match (#X=>x y) [T] { | None => z }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-type-abs");
          assert.equal(scrutinee.typeVar, "X");
          assert.equal(scrutinee.body.kind, "non-terminal");
          assert.equal(scrutinee.body.lft.kind, "systemF-var");
          assert.equal(scrutinee.body.lft.name, "x");
          assert.equal(scrutinee.body.rgt.kind, "systemF-var");
          assert.equal(scrutinee.body.rgt.name, "y");
        },
      );

      await t.step(
        "parses type abstraction with lambda abstraction body as match scrutinee",
        () => {
          // Example: match (#X=>\x:X=>x) [T] { | None => y }
          const input = "match (#X=>\\x:X=>x) [T] { | None => y }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-type-abs");
          assert.equal(scrutinee.typeVar, "X");
          assert.equal(scrutinee.body.kind, "systemF-abs");
          assert.equal(scrutinee.body.name, "x");
          assert.equal(scrutinee.body.typeAnnotation.kind, "type-var");
          assert.equal(scrutinee.body.typeAnnotation.typeName, "X");
        },
      );

      await t.step(
        "parses nested type abstraction as match scrutinee",
        () => {
          // Example: match (#X=>#Y=>x) [T] { | None => z }
          const input = "match (#X=>#Y=>x) [T] { | None => z }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-type-abs");
          assert.equal(scrutinee.typeVar, "X");
          assert.equal(scrutinee.body.kind, "systemF-type-abs");
          assert.equal(scrutinee.body.typeVar, "Y");
          assert.equal(scrutinee.body.body.kind, "systemF-var");
          assert.equal(scrutinee.body.body.name, "x");
        },
      );

      await t.step(
        "parses type abstraction with complex nested body as match scrutinee",
        () => {
          // Example: match (#X=>(\x:X=>x) y) [T] { | None => z }
          const input = "match (#X=>(\\x:X=>x) y) [T] { | None => z }";
          const [_lit, ast] = parseSystemF(input);
          assert.equal(ast.kind, "systemF-match");

          const scrutinee = ast.scrutinee;
          assert.equal(scrutinee.kind, "systemF-type-abs");
          assert.equal(scrutinee.typeVar, "X");
          assert.equal(scrutinee.body.kind, "non-terminal");
          assert.equal(scrutinee.body.lft.kind, "systemF-abs");
          assert.equal(scrutinee.body.lft.name, "x");
          assert.equal(scrutinee.body.rgt.kind, "systemF-var");
          assert.equal(scrutinee.body.rgt.name, "y");
        },
      );

      await t.step("parses numeric literal as match scrutinee", () => {
        // Example: match 123 [T] { | None => y }
        const input = "match 123 [T] { | None => y }";
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");

        // The scrutinee should be a numeric literal variable
        const scrutinee = ast.scrutinee;
        assertNatLiteral(scrutinee, 123n);
        assert.equal(unparseSystemF(scrutinee), "123");
      });

      await t.step("parses character literal as match scrutinee", () => {
        const input = "match 'a' [T] { | None => y }";
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");
        assertNatLiteral(ast.scrutinee, 97n);
      });

      await t.step("parses string literal as match scrutinee", () => {
        const input = 'match "hi" [T] { | None => y }';
        const [_lit, ast] = parseSystemF(input);
        assert.equal(ast.kind, "systemF-match");
        assertNatList(ast.scrutinee, [104n, 105n]);
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
      "should throw error for unexpected character in match scrutinee",
      () => {
        const badInputs = [
          "match !x [T] { | None => y }", // invalid character !
          "match @x [T] { | None => y }", // invalid character @
          "match $x [T] { | None => y }", // invalid character $
          "match %x [T] { | None => y }", // invalid character %
          "match &x [T] { | None => y }", // invalid character &
        ];
        badInputs.forEach((input) => {
          assert.throws(
            () => {
              parseSystemF(input);
            },
            Error,
            "unexpected end-of-input while parsing atomic term",
          );
        });
      },
    );

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

/**
 * The system F parser parses expression on the right hand side of the equals according to triplang keywords.
 * e.g. in `poly foo = "foo"` the "foo" is the system F expression.
 */
Deno.test("parsed a naked atomic", () => {
  const input = '"poly"';
  const [lit, result] = parseSystemF(input);
  assert.equal(lit, input);
  assert.equal(result.kind, "non-terminal");
  // Verify that each character in "poly" is parsed as a natural number
  // 'p'=112, 'o'=111, 'l'=108, 'y'=121
  assertNatList(result, [112n, 111n, 108n, 121n]);
});

Deno.test("parses let inside match arm", () => {
  const input = `\\input : List Nat =>
  match (tokenizeAcc input (nil [Token])) [Result ParseError (List Token)] {
    | Err e => Err [ParseError] [List Token] e
    | Ok rev =>
        let toks = reverse [Token] rev in
        Ok [ParseError] [List Token]
          (append [Token] toks (cons [Token] T_EOF (nil [Token])))
  }`;
  const [_lit, tr] = parseSystemF(input);

  // Top level should be a lambda abstraction
  assert.equal(tr.kind, "systemF-abs");
  assert.equal(tr.name, "input");

  // Type annotation should be List Nat (type application)
  assert.equal(tr.typeAnnotation.kind, "type-app");
  assert.equal(tr.typeAnnotation.fn.kind, "type-var");
  assert.equal(tr.typeAnnotation.fn.typeName, "List");
  assert.equal(tr.typeAnnotation.arg.kind, "type-var");
  assert.equal(tr.typeAnnotation.arg.typeName, "Nat");

  // Body should be a match expression
  assert.equal(tr.body.kind, "systemF-match");
  const matchExpr = tr.body;

  // Match scrutinee: (tokenizeAcc input (nil [Token]))
  // This is a parenthesized application
  assert.equal(matchExpr.scrutinee.kind, "non-terminal");
  const scrutineeApp = matchExpr.scrutinee;
  assert.equal(scrutineeApp.lft.kind, "non-terminal");
  assert.equal(scrutineeApp.lft.lft.kind, "systemF-var");
  assert.equal(scrutineeApp.lft.lft.name, "tokenizeAcc");
  assert.equal(scrutineeApp.lft.rgt.kind, "systemF-var");
  assert.equal(scrutineeApp.lft.rgt.name, "input");
  assert.equal(scrutineeApp.rgt.kind, "systemF-type-app");
  assert.equal(scrutineeApp.rgt.term.kind, "systemF-var");
  assert.equal(scrutineeApp.rgt.term.name, "nil");
  assert.equal(scrutineeApp.rgt.typeArg.kind, "type-var");
  assert.equal(scrutineeApp.rgt.typeArg.typeName, "Token");

  // Match return type: Result ParseError (List Token)
  // This is a nested type application: typeApp(typeApp(Result, ParseError), typeApp(List, Token))
  assert.equal(matchExpr.returnType.kind, "type-app");
  const returnTypeApp = matchExpr.returnType;
  // Outer: typeApp(Result ParseError, List Token)
  assert.equal(returnTypeApp.fn.kind, "type-app");
  assert.equal(returnTypeApp.fn.fn.kind, "type-var");
  assert.equal(returnTypeApp.fn.fn.typeName, "Result");
  assert.equal(returnTypeApp.fn.arg.kind, "type-var");
  assert.equal(returnTypeApp.fn.arg.typeName, "ParseError");
  assert.equal(returnTypeApp.arg.kind, "type-app");
  assert.equal(returnTypeApp.arg.fn.kind, "type-var");
  assert.equal(returnTypeApp.arg.fn.typeName, "List");
  assert.equal(returnTypeApp.arg.arg.kind, "type-var");
  assert.equal(returnTypeApp.arg.arg.typeName, "Token");

  // Match should have 2 arms
  assert.equal(matchExpr.arms.length, 2);

  // First arm: | Err e => Err [ParseError] [List Token] e
  const errArm = matchExpr.arms[0];
  assert.equal(errArm.constructorName, "Err");
  assert.equal(errArm.params.length, 1);
  assert.equal(errArm.params[0], "e");
  // Body: Err [ParseError] [List Token] e
  // Structure: ((Err [ParseError]) [List Token]) e
  assert.equal(errArm.body.kind, "non-terminal");
  const errBody = errArm.body;
  // Left side: (Err [ParseError]) [List Token] - nested type application
  assert.equal(errBody.lft.kind, "systemF-type-app");
  const outerTypeApp = errBody.lft;
  // Inner: Err [ParseError]
  assert.equal(outerTypeApp.term.kind, "systemF-type-app");
  assert.equal(outerTypeApp.term.term.kind, "systemF-var");
  assert.equal(outerTypeApp.term.term.name, "Err");
  assert.equal(outerTypeApp.term.typeArg.kind, "type-var");
  assert.equal(outerTypeApp.term.typeArg.typeName, "ParseError");
  // Outer type arg: List Token (type application)
  assert.equal(outerTypeApp.typeArg.kind, "type-app");
  assert.equal(outerTypeApp.typeArg.fn.kind, "type-var");
  assert.equal(outerTypeApp.typeArg.fn.typeName, "List");
  assert.equal(outerTypeApp.typeArg.arg.kind, "type-var");
  assert.equal(outerTypeApp.typeArg.arg.typeName, "Token");
  // Right side: e
  assert.equal(errBody.rgt.kind, "systemF-var");
  assert.equal(errBody.rgt.name, "e");

  // Second arm: | Ok rev => let toks = reverse [Token] rev in ...
  const okArm = matchExpr.arms[1];
  assert.equal(okArm.constructorName, "Ok");
  assert.equal(okArm.params.length, 1);
  assert.equal(okArm.params[0], "rev");
  // Body should be a let expression
  assert.equal(okArm.body.kind, "systemF-let");
  assert.equal(okArm.body.name, "toks");
  // Let value: reverse [Token] rev
  assert.equal(okArm.body.value.kind, "non-terminal");
  const letValue = okArm.body.value;
  assert.equal(letValue.lft.kind, "systemF-type-app");
  assert.equal(letValue.lft.term.kind, "systemF-var");
  assert.equal(letValue.lft.term.name, "reverse");
  assert.equal(letValue.lft.typeArg.kind, "type-var");
  assert.equal(letValue.lft.typeArg.typeName, "Token");
  assert.equal(letValue.rgt.kind, "systemF-var");
  assert.equal(letValue.rgt.name, "rev");
  // Let body: Ok [ParseError] [List Token] (append [Token] toks (cons [Token] T_EOF (nil [Token])))
  assert.equal(okArm.body.body.kind, "non-terminal");
  const letBody = okArm.body.body;
  // Ok [ParseError] [List Token] (...)
  // Structure: ((Ok [ParseError]) [List Token]) (append ...)
  assert.equal(letBody.lft.kind, "systemF-type-app");
  const okTypeApp = letBody.lft;
  // Inner: Ok [ParseError]
  assert.equal(okTypeApp.term.kind, "systemF-type-app");
  assert.equal(okTypeApp.term.term.kind, "systemF-var");
  assert.equal(okTypeApp.term.term.name, "Ok");
  assert.equal(okTypeApp.term.typeArg.kind, "type-var");
  assert.equal(okTypeApp.term.typeArg.typeName, "ParseError");
  // Outer type arg: List Token (type application)
  assert.equal(okTypeApp.typeArg.kind, "type-app");
  assert.equal(okTypeApp.typeArg.fn.kind, "type-var");
  assert.equal(okTypeApp.typeArg.fn.typeName, "List");
  assert.equal(okTypeApp.typeArg.arg.kind, "type-var");
  assert.equal(okTypeApp.typeArg.arg.typeName, "Token");
  // Right side: (append [Token] toks (cons [Token] T_EOF (nil [Token])))
  // Structure: ((append [Token]) toks) (cons [Token] T_EOF (nil [Token]))
  const appendApp = letBody.rgt;
  assert.equal(appendApp.kind, "non-terminal");
  // Left: (append [Token]) toks
  assert.equal(appendApp.lft.kind, "non-terminal");
  assert.equal(appendApp.lft.lft.kind, "systemF-type-app");
  assert.equal(appendApp.lft.lft.term.kind, "systemF-var");
  assert.equal(appendApp.lft.lft.term.name, "append");
  assert.equal(appendApp.lft.lft.typeArg.kind, "type-var");
  assert.equal(appendApp.lft.lft.typeArg.typeName, "Token");
  assert.equal(appendApp.lft.rgt.kind, "systemF-var");
  assert.equal(appendApp.lft.rgt.name, "toks");
  // Right: (cons [Token] T_EOF (nil [Token]))
  assert.equal(appendApp.rgt.kind, "non-terminal");
  const consApp = appendApp.rgt;
  assert.equal(consApp.lft.kind, "non-terminal");
  assert.equal(consApp.lft.lft.kind, "systemF-type-app");
  assert.equal(consApp.lft.lft.term.kind, "systemF-var");
  assert.equal(consApp.lft.lft.term.name, "cons");
  assert.equal(consApp.lft.lft.typeArg.kind, "type-var");
  assert.equal(consApp.lft.lft.typeArg.typeName, "Token");
  assert.equal(consApp.lft.rgt.kind, "systemF-var");
  assert.equal(consApp.lft.rgt.name, "T_EOF");
  assert.equal(consApp.rgt.kind, "systemF-type-app");
  assert.equal(consApp.rgt.term.kind, "systemF-var");
  assert.equal(consApp.rgt.term.name, "nil");
  assert.equal(consApp.rgt.typeArg.kind, "type-var");
  assert.equal(consApp.rgt.typeArg.typeName, "Token");
});

Deno.test("parses complex nested expr", () => {
  const input = `#A => \\xs : List A =>
  foldl [A] [List A]
    (\\acc : List A => \\x : A => cons [A] x acc)
    (nil [A])
    xs
  `;
  const [_lit, tr] = parseSystemF(input);

  // Top level should be a type abstraction
  assert.equal(tr.kind, "systemF-type-abs");
  assert.equal(tr.typeVar, "A");

  // Body should be a term abstraction
  const termAbs = tr.body;
  assert.equal(termAbs.kind, "systemF-abs");
  assert.equal(termAbs.name, "xs");

  // Type annotation should be List A (type application)
  assert.equal(termAbs.typeAnnotation.kind, "type-app");
  assert.equal(termAbs.typeAnnotation.fn.kind, "type-var");
  assert.equal(termAbs.typeAnnotation.fn.typeName, "List");
  assert.equal(termAbs.typeAnnotation.arg.kind, "type-var");
  assert.equal(termAbs.typeAnnotation.arg.typeName, "A");

  // Body should be a left-associative application chain:
  // foldl [A] [List A] (\acc : List A => \x : A => cons [A] x acc) (nil [A]) xs
  const body = termAbs.body;
  assert.equal(body.kind, "non-terminal");

  // Rightmost argument: xs
  assert.equal(body.rgt.kind, "systemF-var");
  assert.equal(body.rgt.name, "xs");

  // Second-to-rightmost: (nil [A])
  const secondArg = body.lft;
  assert.equal(secondArg.kind, "non-terminal");
  assert.equal(secondArg.rgt.kind, "systemF-type-app");
  assert.equal(secondArg.rgt.term.kind, "systemF-var");
  assert.equal(secondArg.rgt.term.name, "nil");
  assert.equal(secondArg.rgt.typeArg.kind, "type-var");
  assert.equal(secondArg.rgt.typeArg.typeName, "A");

  // Third argument: (\acc : List A => \x : A => cons [A] x acc)
  const thirdArg = secondArg.lft;
  assert.equal(thirdArg.kind, "non-terminal");
  assert.equal(thirdArg.rgt.kind, "systemF-abs");
  const innerAbs = thirdArg.rgt;
  assert.equal(innerAbs.name, "acc");
  assert.equal(innerAbs.typeAnnotation.kind, "type-app");
  assert.equal(innerAbs.typeAnnotation.fn.kind, "type-var");
  assert.equal(innerAbs.typeAnnotation.fn.typeName, "List");
  assert.equal(innerAbs.typeAnnotation.arg.kind, "type-var");
  assert.equal(innerAbs.typeAnnotation.arg.typeName, "A");

  // Inner lambda: \x : A => cons [A] x acc
  assert.equal(innerAbs.body.kind, "systemF-abs");
  const nestedAbs = innerAbs.body;
  assert.equal(nestedAbs.name, "x");
  assert.equal(nestedAbs.typeAnnotation.kind, "type-var");
  assert.equal(nestedAbs.typeAnnotation.typeName, "A");

  // Body: cons [A] x acc
  assert.equal(nestedAbs.body.kind, "non-terminal");
  const consApp = nestedAbs.body;
  assert.equal(consApp.rgt.kind, "systemF-var");
  assert.equal(consApp.rgt.name, "acc");
  assert.equal(consApp.lft.kind, "non-terminal");
  assert.equal(consApp.lft.rgt.kind, "systemF-var");
  assert.equal(consApp.lft.rgt.name, "x");
  assert.equal(consApp.lft.lft.kind, "systemF-type-app");
  assert.equal(consApp.lft.lft.term.kind, "systemF-var");
  assert.equal(consApp.lft.lft.term.name, "cons");
  assert.equal(consApp.lft.lft.typeArg.kind, "type-var");
  assert.equal(consApp.lft.lft.typeArg.typeName, "A");

  // Leftmost: foldl [A] [List A]
  const foldlApp = thirdArg.lft;
  assert.equal(foldlApp.kind, "systemF-type-app");
  assert.equal(foldlApp.term.kind, "systemF-type-app");
  assert.equal(foldlApp.term.term.kind, "systemF-var");
  assert.equal(foldlApp.term.term.name, "foldl");
  assert.equal(foldlApp.term.typeArg.kind, "type-var");
  assert.equal(foldlApp.term.typeArg.typeName, "A");
  assert.equal(foldlApp.typeArg.kind, "type-app");
  assert.equal(foldlApp.typeArg.fn.kind, "type-var");
  assert.equal(foldlApp.typeArg.fn.typeName, "List");
  assert.equal(foldlApp.typeArg.arg.kind, "type-var");
  assert.equal(foldlApp.typeArg.arg.typeName, "A");
});

Deno.test("parses nested let bindings", () => {
  const input = `
  \\input : List Nat => \\accRev : List Token =>
  let clean = dropWhile [Nat] isSpace input in

  matchList [Nat] [Result ParseError (List Token)] clean
    (Ok [ParseError] [List Token] accRev)
    (\\c : Nat => \\cs : List Nat =>

      if [Result ParseError (List Token)]
        (and (eq c '-') (matchList [Nat] [Bool] cs false (\\h : Nat => \\t : List Nat => eq h '>')))
        (\\u : Nat =>
          let rest = tail [Nat] cs in
          tokenizeAcc rest (cons [Token] T_Arrow accRev))
        (\\u : Nat =>

      if [Result ParseError (List Token)]
        (and (eq c '=') (matchList [Nat] [Bool] cs false (\\h : Nat => \\t : List Nat => eq h '>')))
        (\\u : Nat =>
          let rest = tail [Nat] cs in
          tokenizeAcc rest (cons [Token] T_FatArrow accRev))
        (\\u : Nat =>

      match (lookupToken c simpleTokens) [Result ParseError (List Token)] {
        | Some tok =>
            tokenizeAcc cs (cons [Token] tok accRev)

        | None =>
            if [Result ParseError (List Token)] (isAlpha c)
              (\\u : Nat =>
                let split = span [Nat] isIdentChar clean in
                let taken = fst [List Nat] [List Nat] split in
                let remaining = snd [List Nat] [List Nat] split in
                let tok =
                  if [Token] (isKeywordPoly taken)
                    (\\u : Nat => T_Keyword taken)
                    (\\u : Nat => T_Ident taken)
                in
                tokenizeAcc remaining (cons [Token] tok accRev))

              (\\u : Nat =>
                if [Result ParseError (List Token)] (isDigit c)
                  (\\u : Nat =>
                    let split = span [Nat] isDigit clean in
                    let taken = fst [List Nat] [List Nat] split in
                    let remaining = snd [List Nat] [List Nat] split in
                    let n = natFromDigitList taken in
                    tokenizeAcc remaining (cons [Token] (T_Nat n) accRev))

                  (\\u : Nat =>
                    Err [ParseError] [List Token] (MkParseError zero (nil [Nat]))))
      }

      )))
  `;

  const [lit, ast] = parseSystemF(input);

  // Basic sanity checks on the parse tree (non-exhaustive)
  assert.ok(
    lit.includes("let clean ="),
    "expected literal to include top-level let",
  );
  assert.equal(ast.kind, "systemF-abs");
  assert.equal(ast.name, "input");
  assert.equal(ast.typeAnnotation.kind, "type-app");
  assert.equal(ast.typeAnnotation.fn.kind, "type-var");
  assert.equal(ast.typeAnnotation.fn.typeName, "List");
  assert.equal(ast.typeAnnotation.arg.kind, "type-var");
  assert.equal(ast.typeAnnotation.arg.typeName, "Nat");

  // Second lambda: \accRev : List Token => ...
  assert.equal(ast.body.kind, "systemF-abs");
  const abs2 = ast.body;
  assert.equal(abs2.name, "accRev");
  assert.equal(abs2.typeAnnotation.kind, "type-app");
  assert.equal(abs2.typeAnnotation.fn.kind, "type-var");
  assert.equal(abs2.typeAnnotation.fn.typeName, "List");
  assert.equal(abs2.typeAnnotation.arg.kind, "type-var");
  assert.equal(abs2.typeAnnotation.arg.typeName, "Token");

  // Outer let: let clean = dropWhile [Nat] isSpace input in ...
  assert.equal(abs2.body.kind, "systemF-let");
  const cleanLet = abs2.body;
  assert.equal(cleanLet.name, "clean");

  // The body after the let should be an application chain starting with matchList.
  assert.equal(cleanLet.body.kind, "non-terminal");
  const appParts = flattenSystemFApp(cleanLet.body);
  assert.ok(
    appParts.length >= 4,
    "expected matchList application with multiple args",
  );
  assert.equal(appParts[0].kind, "systemF-type-app");
  const head0 = appParts[0];
  assert.equal(head0.term.kind, "systemF-type-app");
  assert.equal(head0.term.term.kind, "systemF-var");
  assert.equal(head0.term.term.name, "matchList");

  // Find a nested `match ... { | Some tok => ... | None => ... }` inside the body.
  const findFirstMatch = (t: SystemFTerm): SystemFTerm | undefined => {
    if (t.kind === "systemF-match") return t;
    if (t.kind === "systemF-abs") return findFirstMatch(t.body);
    if (t.kind === "systemF-type-abs") return findFirstMatch(t.body);
    if (t.kind === "systemF-type-app") return findFirstMatch(t.term);
    if (t.kind === "systemF-let") {
      return findFirstMatch(t.value) ?? findFirstMatch(t.body);
    }
    if (t.kind === "non-terminal") {
      return findFirstMatch(t.lft) ?? findFirstMatch(t.rgt);
    }
    return undefined;
  };

  const matchNode = findFirstMatch(cleanLet.body);
  assert.ok(
    matchNode !== undefined,
    "expected to find a nested match expression",
  );
  assert.equal(matchNode!.kind, "systemF-match");
  assert.equal(matchNode!.arms.length, 2);
  assert.equal(matchNode!.arms[0].constructorName, "Some");
  assert.deepEqual(matchNode!.arms[0].params, ["tok"]);
  assert.equal(matchNode!.arms[1].constructorName, "None");
});

Deno.test("System F type parser", async (t) => {
  await t.step("parses type applications", () => {
    const [lit, ty] = parseWithEOF("List Nat", parseSystemFType);
    const expected = typeApp(
      mkTypeVariable("List"),
      mkTypeVariable("Nat"),
    );
    assert.equal(lit, "List Nat");
    assert.equal(typesLitEq(ty, expected), true);
  });

  await t.step("parses nested type applications", () => {
    const [lit, ty] = parseWithEOF(
      "Result ParseError (Pair A (List Nat))",
      parseSystemFType,
    );
    const listNat = typeApp(mkTypeVariable("List"), mkTypeVariable("Nat"));
    const pair = typeApp(
      typeApp(mkTypeVariable("Pair"), mkTypeVariable("A")),
      listNat,
    );
    const expected = typeApp(
      typeApp(mkTypeVariable("Result"), mkTypeVariable("ParseError")),
      pair,
    );
    assert.equal(lit, "Result ParseError (Pair A (List Nat))");
    assert.equal(typesLitEq(ty, expected), true);
  });

  await t.step("application binds tighter than arrows", () => {
    const [lit, ty] = parseWithEOF("List Nat -> Nat", parseSystemFType);
    const expected = arrow(
      typeApp(mkTypeVariable("List"), mkTypeVariable("Nat")),
      mkTypeVariable("Nat"),
    );
    assert.equal(lit, "List Nat->Nat");
    assert.equal(typesLitEq(ty, expected), true);
  });

  await t.step("unparse renders type applications", () => {
    const listNat = typeApp(mkTypeVariable("List"), mkTypeVariable("Nat"));
    const pair = typeApp(
      typeApp(mkTypeVariable("Pair"), mkTypeVariable("A")),
      listNat,
    );
    assert.equal(unparseSystemFType(pair), "Pair A (List Nat)");
  });
});
