import { assert } from "chai";
import { toDeBruijn } from "../../../lib/meta/frontend/deBruijn.ts";
import type { BaseType } from "../../../lib/types/types.ts";
import type { SystemFTerm } from "../../../lib/terms/systemF.ts";
import type { TypedLambda } from "../../../lib/types/typedLambda.ts";
import type { UntypedLambda } from "../../../lib/terms/lambda.ts";
import { term, SKITerminalSymbol } from "../../../lib/ski/terminal.ts";

Deno.test("De Bruijn Conversion", async (t) => {
  await t.step("should convert free term variables", () => {
    const term: SystemFTerm = { kind: "systemF-var", name: "x" };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, { kind: "DbFreeVar", name: "x" });
  });

  await t.step("should convert bound term variables", () => {
    // λx. x
    const term: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: { kind: "lambda-var", name: "x" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbAbs",
      body: { kind: "DbVar", index: 0 },
    });
  });

  await t.step("should convert nested abstractions with correct indices", () => {
    // λx. λy. x
    const term: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: {
        kind: "lambda-abs",
        name: "y",
        body: { kind: "lambda-var", name: "x" },
      },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbAbs",
      body: {
        kind: "DbAbs",
        body: { kind: "DbVar", index: 1 },
      },
    });
  });

  await t.step("should convert free variables in abstractions", () => {
    // λx. y
    const term: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: { kind: "lambda-var", name: "y" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbAbs",
      body: { kind: "DbFreeVar", name: "y" },
    });
  });

  await t.step("should handle alpha-equivalent terms identically", () => {
    // λx. x
    const term1: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: { kind: "lambda-var", name: "x" },
    };
    // λy. y
    const term2: UntypedLambda = {
      kind: "lambda-abs",
      name: "y",
      body: { kind: "lambda-var", name: "y" },
    };
    const result1 = toDeBruijn(term1);
    const result2 = toDeBruijn(term2);
    assert.deepStrictEqual(result1, result2);
    assert.deepStrictEqual(result1, {
      kind: "DbAbs",
      body: { kind: "DbVar", index: 0 },
    });
  });

  await t.step("should convert System F abstractions", () => {
    // λx: T. x
    const term: SystemFTerm = {
      kind: "systemF-abs",
      name: "x",
      typeAnnotation: { kind: "type-var", typeName: "T" },
      body: { kind: "systemF-var", name: "x" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbSysFAbs",
      typeAnnotation: { kind: "DbFreeTypeVar", name: "T" },
      body: { kind: "DbVar", index: 0 },
    });
  });

  await t.step("should convert typed lambda abstractions", () => {
    // λx: T. x
    const term: TypedLambda = {
      kind: "typed-lambda-abstraction",
      varName: "x",
      ty: { kind: "type-var", typeName: "T" },
      body: { kind: "lambda-var", name: "x" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbTypedAbs",
      type: { kind: "DbFreeTypeVar", name: "T" },
      body: { kind: "DbVar", index: 0 },
    });
  });

  await t.step("should convert System F type abstractions", () => {
    // ΛX. x
    const term: SystemFTerm = {
      kind: "systemF-type-abs",
      typeVar: "X",
      body: { kind: "systemF-var", name: "x" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbTyAbs",
      body: { kind: "DbFreeVar", name: "x" },
    });
  });

  await t.step("should convert applications", () => {
    // x y
    const term: UntypedLambda = {
      kind: "non-terminal",
      lft: { kind: "lambda-var", name: "x" },
      rgt: { kind: "lambda-var", name: "y" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbApp",
      left: { kind: "DbFreeVar", name: "x" },
      right: { kind: "DbFreeVar", name: "y" },
    });
  });

  await t.step("should convert System F type applications", () => {
    // t [T]
    const term: SystemFTerm = {
      kind: "systemF-type-app",
      term: { kind: "systemF-var", name: "t" },
      typeArg: { kind: "type-var", typeName: "T" },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbTyApp",
      term: { kind: "DbFreeVar", name: "t" },
      typeArg: { kind: "DbFreeTypeVar", name: "T" },
    });
  });

  await t.step("should convert terminals", () => {
    const terminal = term(SKITerminalSymbol.S);
    const result = toDeBruijn(terminal);
    assert.deepStrictEqual(result, { kind: "DbTerminal", sym: "S" });
  });

  await t.step("should convert type variables", () => {
    const type: BaseType = { kind: "type-var", typeName: "X" };
    const result = toDeBruijn(type);
    assert.deepStrictEqual(result, { kind: "DbFreeTypeVar", name: "X" });
  });

  await t.step("should convert bound type variables in forall", () => {
    // ∀X. X
    const type: BaseType = {
      kind: "forall",
      typeVar: "X",
      body: { kind: "type-var", typeName: "X" },
    };
    const result = toDeBruijn(type);
    assert.deepStrictEqual(result, {
      kind: "DbForall",
      body: { kind: "DbVar", index: 0 },
    });
  });

  await t.step("should convert nested forall types", () => {
    // ∀X. ∀Y. X
    const type: BaseType = {
      kind: "forall",
      typeVar: "X",
      body: {
        kind: "forall",
        typeVar: "Y",
        body: { kind: "type-var", typeName: "X" },
      },
    };
    const result = toDeBruijn(type);
    assert.deepStrictEqual(result, {
      kind: "DbForall",
      body: {
        kind: "DbForall",
        body: { kind: "DbVar", index: 1 },
      },
    });
  });

  await t.step("should convert arrow types", () => {
    // T → U
    const type: BaseType = {
      kind: "non-terminal",
      lft: { kind: "type-var", typeName: "T" },
      rgt: { kind: "type-var", typeName: "U" },
    };
    const result = toDeBruijn(type);
    assert.deepStrictEqual(result, {
      kind: "DbApp",
      left: { kind: "DbFreeTypeVar", name: "T" },
      right: { kind: "DbFreeTypeVar", name: "U" },
    });
  });

  await t.step("should handle complex nested structures", () => {
    // λx. (λy. x) y
    const term: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: {
        kind: "non-terminal",
        lft: {
          kind: "lambda-abs",
          name: "y",
          body: { kind: "lambda-var", name: "x" },
        },
        rgt: { kind: "lambda-var", name: "y" },
      },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbAbs",
      body: {
        kind: "DbApp",
        left: {
          kind: "DbAbs",
          body: { kind: "DbVar", index: 1 },
        },
        right: { kind: "DbFreeVar", name: "y" },
      },
    });
  });

  await t.step("should handle mixed term and type abstractions", () => {
    // ΛX. λx: X. x
    const term: SystemFTerm = {
      kind: "systemF-type-abs",
      typeVar: "X",
      body: {
        kind: "systemF-abs",
        name: "x",
        typeAnnotation: { kind: "type-var", typeName: "X" },
        body: { kind: "systemF-var", name: "x" },
      },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbTyAbs",
      body: {
        kind: "DbSysFAbs",
        typeAnnotation: { kind: "DbVar", index: 0 },
        body: { kind: "DbVar", index: 0 },
      },
    });
  });

  await t.step("should handle K combinator structure", () => {
    // λx. λy. x
    const term: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: {
        kind: "lambda-abs",
        name: "y",
        body: { kind: "lambda-var", name: "x" },
      },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbAbs",
      body: {
        kind: "DbAbs",
        body: { kind: "DbVar", index: 1 },
      },
    });
  });

  await t.step("should handle S combinator structure", () => {
    // λx. λy. λz. (x z) (y z)
    const term: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: {
        kind: "lambda-abs",
        name: "y",
        body: {
          kind: "lambda-abs",
          name: "z",
          body: {
            kind: "non-terminal",
            lft: {
              kind: "non-terminal",
              lft: { kind: "lambda-var", name: "x" },
              rgt: { kind: "lambda-var", name: "z" },
            },
            rgt: {
              kind: "non-terminal",
              lft: { kind: "lambda-var", name: "y" },
              rgt: { kind: "lambda-var", name: "z" },
            },
          },
        },
      },
    };
    const result = toDeBruijn(term);
    assert.deepStrictEqual(result, {
      kind: "DbAbs",
      body: {
        kind: "DbAbs",
        body: {
          kind: "DbAbs",
          body: {
            kind: "DbApp",
            left: {
              kind: "DbApp",
              left: { kind: "DbVar", index: 2 },
              right: { kind: "DbVar", index: 0 },
            },
            right: {
              kind: "DbApp",
              left: { kind: "DbVar", index: 1 },
              right: { kind: "DbVar", index: 0 },
            },
          },
        },
      },
    });
  });

  await t.step("should produce stable hashes for alpha-equivalent terms", () => {
    // λa. λb. a
    const term1: UntypedLambda = {
      kind: "lambda-abs",
      name: "a",
      body: {
        kind: "lambda-abs",
        name: "b",
        body: { kind: "lambda-var", name: "a" },
      },
    };
    // λx. λy. x
    const term2: UntypedLambda = {
      kind: "lambda-abs",
      name: "x",
      body: {
        kind: "lambda-abs",
        name: "y",
        body: { kind: "lambda-var", name: "x" },
      },
    };
    const result1 = JSON.stringify(toDeBruijn(term1));
    const result2 = JSON.stringify(toDeBruijn(term2));
    assert.strictEqual(result1, result2);
  });
});

