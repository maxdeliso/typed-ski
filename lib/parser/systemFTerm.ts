/**
 * System F term parser.
 *
 * This module provides parsing functionality for System F (polymorphic lambda calculus)
 * terms, including variables, abstractions, type abstractions, and applications.
 *
 * Arrow Syntax:
 * - Type arrows use "->": "T -> U" means function type from T to U
 * - Term arrows use "=>": "\\x => body" or "match x { | C => body }"
 *   Match arms specifically use "=>" (fat arrow), not "->" (skinny arrow)
 *
 * Uses consistent Recursive Descent; precedence is handled via: Atom < App < Term.
 *
 * @module
 */
import { ParseError } from "./parseError.ts";
import {
  isAtDefinitionKeywordLine,
  isDigit,
  matchCh,
  matchFatArrow,
  matchLP,
  matchRP,
  parseIdentifier,
  parseNumericLiteral,
  peek,
  peekFatArrow,
  peekBindArrow,
  matchBindArrow,
  skipWhitespace,
  withParserState,
} from "./parserState.ts";
import type { ParserState } from "./parserState.ts";
import type { BaseType } from "../types/types.ts";
import { mkTypeVariable } from "../types/types.ts";
import { parseSystemFType } from "./systemFType.ts";
import { parseWithEOF } from "./eof.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFMatchArm,
  type SystemFTerm,
} from "../terms/systemF.ts";
import {
  createSystemFApplication,
  flattenSystemFApp,
} from "../terms/systemF.ts";
import {
  BACKSLASH,
  COLON,
  EQUALS,
  FAT_ARROW,
  HASH,
  LEFT_BRACE,
  LEFT_PAREN,
  RIGHT_BRACE,
  RIGHT_PAREN,
} from "./consts.ts";
import {
  makeNatLiteralIdentifier,
  parseNatLiteralIdentifier,
} from "../consts/natNames.ts";
import { unparseSystemFType } from "./systemFType.ts";

/**
 * Checks if the upcoming token should terminate a chain of applications.
 * An application chain (e.g., `f x y`) stops if we see:
 * - A closing parenthesis/brace/bracket: `)`, `}`, `]`
 * - A match arm delimiter: `|`
 * - The start of a match block: `{`
 * - A keyword that starts a new structure: `in` (for let)
 * - The start of a new definition line
 */
let parsingDoBlockDepth = 0;

function isStartOfDoStep(state: ParserState): boolean {
  try {
    const newState = skipWhitespace(state);
    const [ch] = peek(newState);
    if (ch === null || !/[a-zA-Z]/.test(ch)) return false;

    const [word, stateAfterWord] = parseIdentifier(newState);
    if (word === "assert" || word === "return") return true;

    const [isBind] = peekBindArrow(stateAfterWord);
    if (isBind) return true;

    // Check if followed by =
    let pCursor = stateAfterWord.idx;
    let depth = 0;
    let inString = false;
    while (pCursor < stateAfterWord.buf.length) {
      const char = stateAfterWord.buf[pCursor];
      if (char === '"') {
        inString = !inString;
      }
      if (!inString) {
        if (
          char === "\n" ||
          char === "\r" ||
          char === ";" ||
          char === "|" ||
          char === "}"
        ) {
          break;
        }
        if (char === "(" || char === "[" || char === "{") depth++;
        else if (char === ")" || char === "]" || char === "}") depth--;

        if (depth === 0 && char === "=") {
          if (stateAfterWord.buf[pCursor + 1] !== ">") {
            return true;
          }
        }
      }
      pCursor++;
    }
  } catch {
    return false;
  }
  return false;
}

function isTerminator(state: ParserState): boolean {
  const [isFatArrow] = peekFatArrow(state);
  if (isFatArrow) return true;

  if (parsingDoBlockDepth > 0 && isStartOfDoStep(state)) return true;

  const [ch, _] = peek(state);

  if (ch === null) return true;
  if (isAtDefinitionKeywordLine(state)) return true;

  // Structural delimiters
  if (
    ch === RIGHT_PAREN ||
    ch === RIGHT_BRACE ||
    ch === "]" ||
    ch === "|" ||
    ch === ","
  ) {
    return true;
  }

  // Keywords that end expressions (specifically 'in' for let-bindings and 'else' for assert guards)
  if (/[a-zA-Z]/.test(ch)) {
    try {
      const [id] = parseIdentifier(state);
      if (id === "in" || id === "else") return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Parses a complete match expression.
 * `match scrutinee [Type] { | Ctor vars => body ... }`
 */
function parseMatchExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  // 1. Scrutinee
  const [headLit, headTerm, headState] = parseAtomicSystemFTerm(state);

  let scrutineeLit = headLit;
  let scrutinee = headTerm;
  let currentState = headState;

  for (let matchLength = 0; ; matchLength = matchLength + 1) {
    currentState = skipWhitespace(currentState);

    // Standard termination checks
    if (isTerminator(currentState)) break;

    const [ch] = peek(currentState);

    // SPECIAL CASE: Stop at '[' or '{' because it denotes either the return type or the match block
    if (ch === "[" || ch === "{") break;

    // Parse next term application
    const [atomLit, atomTerm, nextState] = parseAtomicSystemFTerm(currentState);
    scrutineeLit = `${scrutineeLit} ${atomLit}`;
    scrutinee = createSystemFApplication(scrutinee, atomTerm);
    currentState = nextState;
  }

  currentState = skipWhitespace(currentState);

  // 2. Return Type [T]
  const [nextCh, peekState] = peek(currentState);
  if (nextCh !== "[") {
    throw new ParseError(
      withParserState(
        peekState,
        "match requires an explicit return type: match <term> [Type] { ... }",
      ),
    );
  }
  currentState = matchCh(peekState, "[");
  // Ensure we skip whitespace before parsing the type
  currentState = skipWhitespace(currentState);
  const [returnTypeLit, returnType, stateAfterType] =
    parseSystemFType(currentState);

  currentState = skipWhitespace(stateAfterType);
  currentState = matchCh(currentState, "]");

  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, LEFT_BRACE);
  currentState = skipWhitespace(currentState);

  const arms: SystemFMatchArm[] = [];

  // 3. Arms
  for (let armLength = 0; ; armLength = armLength + 1) {
    currentState = skipWhitespace(currentState);
    const [nextArmCh] = peek(currentState);

    // Check for end of match block
    if (nextArmCh === RIGHT_BRACE) {
      currentState = matchCh(currentState, RIGHT_BRACE);
      break;
    }

    if (nextArmCh !== "|") {
      throw new ParseError(
        withParserState(currentState, "expected '|' to start match arm"),
      );
    }
    currentState = matchCh(currentState, "|");
    currentState = skipWhitespace(currentState);

    // Constructor Name
    const [constructorName, stateAfterCtor] = parseIdentifier(currentState);
    currentState = skipWhitespace(stateAfterCtor);

    // Parameters (identifiers until =>)
    const params: string[] = [];
    for (let paramLength = 0; ; paramLength = paramLength + 1) {
      const [isArrow, arrowState] = peekFatArrow(currentState);
      if (isArrow) {
        currentState = matchFatArrow(arrowState);
        break;
      }
      const [param, stateAfterParam] = parseIdentifier(currentState);
      params.push(param);
      currentState = skipWhitespace(stateAfterParam);
    }

    currentState = skipWhitespace(currentState);

    // Body
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(currentState);
    currentState = skipWhitespace(stateAfterBody);

    arms.push({ constructorName, params, body: bodyTerm });
    if (bodyLit.length === 0) {
      throw new ParseError(
        withParserState(stateAfterBody, "match arm requires a body"),
      );
    }
  }

  if (arms.length === 0) {
    throw new ParseError(
      withParserState(currentState, "match must declare at least one arm"),
    );
  }

  return [
    `match ${scrutineeLit} [${returnTypeLit}] {...}`,
    { kind: "systemF-match", scrutinee, returnType, arms },
    currentState,
  ];
}

/**
 * Parses a let binding.
 * `let x [: Type] = Val in Body`
 */
function parseLetExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [name, stateAfterName] = parseIdentifier(state);
  let currentState = skipWhitespace(stateAfterName);
  let typeAnnotation: BaseType | undefined;
  let typeLit = "";

  // Optional Type Annotation
  const [nextCh] = peek(currentState);
  if (nextCh === COLON) {
    currentState = matchCh(currentState, COLON);
    currentState = skipWhitespace(currentState); // Skip space after colon
    [typeLit, typeAnnotation, currentState] = parseSystemFType(currentState);
    currentState = skipWhitespace(currentState);
  }

  currentState = matchCh(currentState, EQUALS);
  currentState = skipWhitespace(currentState);

  // Value Term
  const [valueLit, valueTerm, stateAfterVal] = parseSystemFTerm(currentState);
  currentState = skipWhitespace(stateAfterVal);

  // Expect 'in'
  const [inKw, stateAfterIn] = parseIdentifier(currentState);
  if (inKw !== "in") {
    throw new ParseError(
      withParserState(
        currentState,
        `expected 'in' after let binding value, found '${inKw}'`,
      ),
    );
  }
  currentState = skipWhitespace(stateAfterIn);

  // Body Term
  const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(currentState);

  const letLit = typeLit
    ? `let ${name} : ${typeLit} = ${valueLit} in ${bodyLit}`
    : `let ${name} = ${valueLit} in ${bodyLit}`;

  if (typeAnnotation !== undefined) {
    return [
      letLit,
      createSystemFApplication(
        mkSystemFAbs(name, typeAnnotation, bodyTerm),
        valueTerm,
      ),
      stateAfterBody,
    ];
  }
  return [
    letLit,
    { kind: "systemF-let", name, value: valueTerm, body: bodyTerm },
    stateAfterBody,
  ];
}

const DEFAULT_DELAY_PARAM = "u";
const GENERATED_DELAY_PARAM_PREFIX = "__cond_u";

function collectFreeSystemFTermNames(
  term: SystemFTerm,
  bound: ReadonlySet<string>,
  free: Set<string>,
): void {
  switch (term.kind) {
    case "systemF-var": {
      if (
        !bound.has(term.name) &&
        parseNatLiteralIdentifier(term.name) === null &&
        !/^__trip_u8_\d+$/.test(term.name)
      ) {
        free.add(term.name);
      }
      return;
    }
    case "non-terminal":
      collectFreeSystemFTermNames(term.lft, bound, free);
      collectFreeSystemFTermNames(term.rgt, bound, free);
      return;
    case "systemF-abs": {
      const nextBound = new Set(bound);
      nextBound.add(term.name);
      collectFreeSystemFTermNames(term.body, nextBound, free);
      return;
    }
    case "systemF-type-abs":
      collectFreeSystemFTermNames(term.body, bound, free);
      return;
    case "systemF-type-app":
      collectFreeSystemFTermNames(term.term, bound, free);
      return;
    case "systemF-let": {
      collectFreeSystemFTermNames(term.value, bound, free);
      const nextBound = new Set(bound);
      nextBound.add(term.name);
      collectFreeSystemFTermNames(term.body, nextBound, free);
      return;
    }
    case "systemF-match":
      collectFreeSystemFTermNames(term.scrutinee, bound, free);
      for (const arm of term.arms) {
        const armBound = new Set(bound);
        for (const param of arm.params) {
          armBound.add(param);
        }
        collectFreeSystemFTermNames(arm.body, armBound, free);
      }
      return;
  }
}

function freshCondDelayParam(terms: readonly SystemFTerm[]): string {
  const free = new Set<string>();
  for (const term of terms) {
    collectFreeSystemFTermNames(term, new Set(), free);
  }
  if (!free.has(DEFAULT_DELAY_PARAM)) return DEFAULT_DELAY_PARAM;

  for (let i = 0; ; i++) {
    const candidate = `${GENERATED_DELAY_PARAM_PREFIX}_${i}`;
    if (!free.has(candidate)) return candidate;
  }
}

function buildCondIf(
  returnType: BaseType,
  condition: SystemFTerm,
  thenBody: SystemFTerm,
  elseBody: SystemFTerm,
): SystemFTerm {
  const delayParam = freshCondDelayParam([thenBody, elseBody]);
  const ifTyped = mkSystemFTypeApp(mkSystemFVar("if"), returnType);
  return createSystemFApplication(
    createSystemFApplication(
      createSystemFApplication(ifTyped, condition),
      mkSystemFAbs(delayParam, mkTypeVariable("U8"), thenBody),
    ),
    mkSystemFAbs(delayParam, mkTypeVariable("U8"), elseBody),
  );
}

function desugarCond(
  returnType: BaseType,
  arms: readonly { cond: SystemFTerm; body: SystemFTerm }[],
  defaultBody: SystemFTerm,
): SystemFTerm {
  let currentElse = defaultBody;
  for (let i = arms.length - 1; i >= 0; i--) {
    const arm = arms[i]!;
    currentElse = buildCondIf(returnType, arm.cond, arm.body, currentElse);
  }
  return currentElse;
}

/**
 * Parses a cond expression:
 * `cond [Type] { | Cond_1 => Body_1 ... | otherwise => Default_Body }`
 */
function parseCondExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  let currentState = skipWhitespace(state);
  const [nextCh, peekState] = peek(currentState);
  if (nextCh !== "[") {
    throw new ParseError(
      withParserState(
        peekState,
        "cond requires an explicit return type: cond [Type] { ... }",
      ),
    );
  }
  currentState = matchCh(peekState, "[");
  currentState = skipWhitespace(currentState);
  const [returnTypeLit, returnType, stateAfterType] =
    parseSystemFType(currentState);

  currentState = skipWhitespace(stateAfterType);
  currentState = matchCh(currentState, "]");

  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, LEFT_BRACE);
  currentState = skipWhitespace(currentState);

  const arms: {
    condLit: string;
    cond: SystemFTerm;
    bodyLit: string;
    body: SystemFTerm;
  }[] = [];
  let defaultArm: { bodyLit: string; body: SystemFTerm } | undefined =
    undefined;

  for (let armLength = 0; ; armLength = armLength + 1) {
    currentState = skipWhitespace(currentState);
    const [nextArmCh] = peek(currentState);

    if (nextArmCh === RIGHT_BRACE) {
      currentState = matchCh(currentState, RIGHT_BRACE);
      break;
    }

    if (nextArmCh !== "|") {
      throw new ParseError(
        withParserState(currentState, "expected '|' to start cond arm"),
      );
    }
    currentState = matchCh(currentState, "|");
    currentState = skipWhitespace(currentState);

    const [condLit, condTerm, stateAfterCond] = parseSystemFTerm(currentState);
    currentState = skipWhitespace(stateAfterCond);

    const [isArrow, arrowState] = peekFatArrow(currentState);
    if (!isArrow) {
      throw new ParseError(
        withParserState(currentState, "expected '=>' after cond arm condition"),
      );
    }
    currentState = matchFatArrow(arrowState);
    currentState = skipWhitespace(currentState);

    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(currentState);
    currentState = skipWhitespace(stateAfterBody);

    if (condTerm.kind === "systemF-var" && condTerm.name === "otherwise") {
      defaultArm = { bodyLit, body: bodyTerm };
      currentState = skipWhitespace(currentState);
      currentState = matchCh(currentState, RIGHT_BRACE);
      break;
    } else {
      arms.push({ condLit, cond: condTerm, bodyLit, body: bodyTerm });
    }
  }

  if (defaultArm === undefined) {
    throw new ParseError(
      withParserState(currentState, "cond requires a default 'otherwise' arm"),
    );
  }

  const finalTerm = desugarCond(returnType, arms, defaultArm.body);

  const armLits = arms
    .map((arm) => `| ${arm.condLit} => ${arm.bodyLit}`)
    .join(" ");
  const literalStr =
    arms.length === 0
      ? `cond [${returnTypeLit}] { | otherwise => ${defaultArm.bodyLit} }`
      : `cond [${returnTypeLit}] { ${armLits} | otherwise => ${defaultArm.bodyLit} }`;

  return [literalStr, finalTerm, currentState];
}

type DoStep =
  | { kind: "bind"; name: string; exprLit: string; expr: SystemFTerm }
  | { kind: "let"; name: string; exprLit: string; expr: SystemFTerm }
  | {
      kind: "match";
      constructorName: string;
      params: string[];
      exprLit: string;
      expr: SystemFTerm;
    }
  | {
      kind: "assert";
      condLit: string;
      cond: SystemFTerm;
      errorLit: string;
      error: SystemFTerm;
    }
  | { kind: "return"; valLit: string; val: SystemFTerm }
  | { kind: "expr"; exprLit: string; expr: SystemFTerm };

function parseDoExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  parsingDoBlockDepth++;
  try {
    return parseDoExpressionInternal(state);
  } finally {
    parsingDoBlockDepth--;
  }
}

function parseDoExpressionInternal(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  let currentState = skipWhitespace(state);
  const [nextCh, peekState] = peek(currentState);
  if (nextCh !== "[") {
    throw new ParseError(
      withParserState(
        peekState,
        "do requires an explicit return type: do [Type] { ... }",
      ),
    );
  }
  currentState = matchCh(peekState, "[");
  currentState = skipWhitespace(currentState);
  const [returnTypeLit, returnType, stateAfterType] =
    parseSystemFType(currentState);

  currentState = skipWhitespace(stateAfterType);
  currentState = matchCh(currentState, "]");

  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, LEFT_BRACE);
  currentState = skipWhitespace(currentState);

  const steps: DoStep[] = [];

  for (;;) {
    currentState = skipWhitespace(currentState);
    const [nextArmCh] = peek(currentState);

    if (nextArmCh === RIGHT_BRACE) {
      currentState = matchCh(currentState, RIGHT_BRACE);
      break;
    }

    if (nextArmCh === null) {
      throw new ParseError(
        withParserState(currentState, "unterminated do block"),
      );
    }

    const [firstWord, stateAfterFirst] = parseIdentifier(currentState);
    const stateAfterFirstWS = skipWhitespace(stateAfterFirst);

    if (firstWord === "assert") {
      currentState = stateAfterFirstWS;
      const [condLit, condTerm, stateAfterCond] =
        parseSystemFTerm(currentState);
      currentState = skipWhitespace(stateAfterCond);

      const [elseWord, stateAfterElse] = parseIdentifier(currentState);
      if (elseWord !== "else") {
        throw new ParseError(
          withParserState(
            currentState,
            "expected 'else' after assert condition",
          ),
        );
      }
      currentState = skipWhitespace(stateAfterElse);
      const [errorLit, errorTerm, stateAfterError] =
        parseSystemFTerm(currentState);
      currentState = stateAfterError;

      steps.push({
        kind: "assert",
        condLit,
        cond: condTerm,
        errorLit,
        error: errorTerm,
      });
    } else if (firstWord === "return") {
      currentState = stateAfterFirstWS;
      const [valLit, valTerm, stateAfterVal] = parseSystemFTerm(currentState);
      currentState = stateAfterVal;

      steps.push({ kind: "return", valLit, val: valTerm });
    } else {
      const [isBind, stateAfterCheck] = peekBindArrow(stateAfterFirst);
      if (isBind) {
        currentState = matchBindArrow(stateAfterCheck);
        const [exprLit, exprTerm, stateAfterExpr] =
          parseSystemFTerm(currentState);
        currentState = stateAfterExpr;

        steps.push({ kind: "bind", name: firstWord, exprLit, expr: exprTerm });
      } else {
        let hasEq = false;
        let pCursor = stateAfterFirstWS.idx;
        let depthP = 0;
        let depthB = 0;
        let depthBr = 0;
        while (pCursor < stateAfterFirstWS.buf.length) {
          const char = stateAfterFirstWS.buf[pCursor];
          if (char === "}") break;
          if (char === "\n" || char === ";" || char === "|") {
            break;
          }
          if (char === "(") depthP++;
          else if (char === ")") depthP--;
          else if (char === "[") depthB++;
          else if (char === "]") depthB--;
          else if (char === "{") depthBr++;
          else if (char === "}") depthBr--;

          if (depthP === 0 && depthB === 0 && depthBr === 0 && char === "=") {
            if (stateAfterFirstWS.buf[pCursor + 1] !== ">") {
              hasEq = true;
              break;
            }
          }
          pCursor++;
        }

        if (hasEq) {
          let patternState = stateAfterFirstWS;
          const params: string[] = [];
          for (;;) {
            const [nextCh] = peek(patternState);
            if (nextCh === "=") {
              patternState = matchCh(patternState, "=");
              break;
            }
            const [param, stateAfterParam] = parseIdentifier(patternState);
            params.push(param);
            patternState = skipWhitespace(stateAfterParam);
          }

          currentState = skipWhitespace(patternState);
          const [exprLit, exprTerm, stateAfterExpr] =
            parseSystemFTerm(currentState);
          currentState = stateAfterExpr;

          if (
            params.length === 0 &&
            firstWord[0] === firstWord[0]!.toLowerCase()
          ) {
            steps.push({
              kind: "let",
              name: firstWord,
              exprLit,
              expr: exprTerm,
            });
          } else {
            steps.push({
              kind: "match",
              constructorName: firstWord,
              params,
              exprLit,
              expr: exprTerm,
            });
          }
        } else {
          const [exprLit, exprTerm, stateAfterExpr] =
            parseSystemFTerm(currentState);
          currentState = stateAfterExpr;
          steps.push({ kind: "expr", exprLit, expr: exprTerm });
        }
      }
    }
  }

  if (steps.length === 0) {
    throw new ParseError(
      withParserState(currentState, "do block requires at least one step"),
    );
  }

  let errorType: BaseType | undefined;
  let okType: BaseType | undefined;
  if (returnType.kind === "type-app" && returnType.fn.kind === "type-app") {
    errorType = returnType.fn.arg;
    okType = returnType.arg;
  } else {
    errorType = mkTypeVariable("List U8");
    okType = returnType;
  }

  const u8Type = mkTypeVariable("U8");

  const makeErrTerm = (err: SystemFTerm): SystemFTerm => {
    return createSystemFApplication(
      mkSystemFTypeApp(
        mkSystemFTypeApp(mkSystemFVar("Err"), errorType!),
        okType!,
      ),
      err,
    );
  };

  const makeOkTerm = (val: SystemFTerm): SystemFTerm => {
    return createSystemFApplication(
      mkSystemFTypeApp(
        mkSystemFTypeApp(mkSystemFVar("Ok"), errorType!),
        okType!,
      ),
      val,
    );
  };

  const lastStep = steps[steps.length - 1]!;
  let currentTerm: SystemFTerm;

  if (lastStep.kind === "return") {
    currentTerm = lastStep.val;
  } else if (lastStep.kind === "expr") {
    currentTerm = lastStep.expr;
  } else {
    throw new ParseError(
      withParserState(
        currentState,
        "do block final step must be an expression or a return statement",
      ),
    );
  }

  for (let i = steps.length - 2; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind === "bind") {
      currentTerm = {
        kind: "systemF-match",
        scrutinee: step.expr,
        returnType,
        arms: [
          {
            constructorName: "Err",
            params: ["e"],
            body: makeErrTerm(mkSystemFVar("e")),
          },
          {
            constructorName: "Ok",
            params: [step.name],
            body: currentTerm,
          },
        ],
      };
    } else if (step.kind === "match") {
      currentTerm = {
        kind: "systemF-match",
        scrutinee: step.expr,
        returnType,
        arms: [
          {
            constructorName: step.constructorName,
            params: step.params,
            body: currentTerm,
          },
        ],
      };
    } else if (step.kind === "let") {
      currentTerm = {
        kind: "systemF-let",
        name: step.name,
        value: step.expr,
        body: currentTerm,
      };
    } else if (step.kind === "assert") {
      const ifVar = mkSystemFVar("if");
      const ifTyped = mkSystemFTypeApp(ifVar, returnType);
      const thenBranch = mkSystemFAbs("u", u8Type, currentTerm);
      const elseBranch = mkSystemFAbs("u", u8Type, makeErrTerm(step.error));

      currentTerm = createSystemFApplication(
        createSystemFApplication(
          createSystemFApplication(ifTyped, step.cond),
          thenBranch,
        ),
        elseBranch,
      );
    } else {
      const exprValue = step.kind === "return" ? step.val : step.expr;
      currentTerm = {
        kind: "systemF-let",
        name: "_",
        value: exprValue,
        body: currentTerm,
      };
    }
  }

  const stepLits = steps
    .map((step) => {
      if (step.kind === "bind") return `${step.name} <- ${step.exprLit}`;
      if (step.kind === "let") return `${step.name} = ${step.exprLit}`;
      if (step.kind === "match")
        return `${step.constructorName} ${step.params.join(" ")} = ${step.exprLit}`;
      if (step.kind === "assert")
        return `assert ${step.condLit} else ${step.errorLit}`;
      if (step.kind === "return") return `return ${step.valLit}`;
      return step.exprLit;
    })
    .join("\n      ");

  const literalStr = `do [${returnTypeLit}] {
      ${stepLits}
    }`;

  return [literalStr, currentTerm, currentState];
}

const ASCII_PRINTABLE_MIN = 32;
const ASCII_PRINTABLE_MAX = 126;

const isPrintableAscii = (code: number): boolean =>
  code >= ASCII_PRINTABLE_MIN && code <= ASCII_PRINTABLE_MAX;

const consumeRaw = (state: ParserState, expected: string): ParserState => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(
      withParserState(state, `expected '${expected}' but found EOF`),
    );
  }
  const ch = state.buf[state.idx];
  if (ch !== expected) {
    throw new ParseError(
      withParserState(state, `expected '${expected}' but found '${ch}'`),
    );
  }
  return { buf: state.buf, idx: state.idx + 1 };
};

const parseEscape = (
  state: ParserState,
  context: "character" | "string",
): [string, number, ParserState] => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(
      withParserState(state, `unterminated ${context} literal`),
    );
  }
  const esc = state.buf[state.idx];
  let code: number;
  switch (esc) {
    case "n":
      code = 10;
      break;
    case "r":
      code = 13;
      break;
    case "t":
      code = 9;
      break;
    case "\\":
      code = 92;
      break;
    case "'":
      code = 39;
      break;
    case '"':
      code = 34;
      break;
    default:
      throw new ParseError(
        withParserState(
          state,
          `unsupported escape sequence '\\${esc}' in ${context} literal`,
        ),
      );
  }
  return [`\\${esc}`, code, { buf: state.buf, idx: state.idx + 1 }];
};

const parseLiteralChar = (
  state: ParserState,
  context: "character" | "string",
): [string, number, ParserState] => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(
      withParserState(state, `unterminated ${context} literal`),
    );
  }
  const ch = state.buf[state.idx]!;
  if (ch === "\n" || ch === "\r") {
    throw new ParseError(
      withParserState(state, `unterminated ${context} literal`),
    );
  }
  if (ch === "\\") {
    return parseEscape({ buf: state.buf, idx: state.idx + 1 }, context);
  }
  const code = ch.charCodeAt(0);
  if (!isPrintableAscii(code)) {
    throw new ParseError(
      withParserState(state, `non-printable ASCII in ${context} literal`),
    );
  }
  return [ch, code, { buf: state.buf, idx: state.idx + 1 }];
};

const makeU8Type = (): BaseType => mkTypeVariable("U8");

/** Builds List U8: cons [U8] (#u8(c)) … (nil [U8]). Each code becomes __trip_u8_<code>. */
const buildU8List = (codes: number[]): SystemFTerm => {
  const u8Type = makeU8Type();
  let term: SystemFTerm = mkSystemFTypeApp(mkSystemFVar("nil"), u8Type);
  for (let i = codes.length - 1; i >= 0; i--) {
    const consTerm = mkSystemFTypeApp(mkSystemFVar("cons"), u8Type);
    const head = mkSystemFVar(`__trip_u8_${codes[i]!}`);
    term = createSystemFApplication(
      createSystemFApplication(consTerm, head),
      term,
    );
  }
  return term;
};

const buildListLiteral = (
  elementType: BaseType,
  elements: SystemFTerm[],
): SystemFTerm => {
  let term: SystemFTerm = mkSystemFTypeApp(mkSystemFVar("nil"), elementType);
  for (let i = elements.length - 1; i >= 0; i--) {
    const consTerm = mkSystemFTypeApp(mkSystemFVar("cons"), elementType);
    term = createSystemFApplication(
      createSystemFApplication(consTerm, elements[i]!),
      term,
    );
  }
  return term;
};

const parseCharLiteralTerm = (
  state: ParserState,
): [string, SystemFTerm, ParserState] => {
  let currentState = consumeRaw(state, "'");
  if (currentState.idx >= currentState.buf.length) {
    throw new ParseError(
      withParserState(currentState, "unterminated character literal"),
    );
  }
  const nextCh = currentState.buf[currentState.idx];
  if (nextCh === "'" || nextCh === "\n" || nextCh === "\r") {
    throw new ParseError(
      withParserState(currentState, "empty character literal"),
    );
  }
  let literalPart: string;
  let code: number;
  if (nextCh === "\\") {
    [literalPart, code, currentState] = parseEscape(
      { buf: currentState.buf, idx: currentState.idx + 1 },
      "character",
    );
  } else {
    [literalPart, code, currentState] = parseLiteralChar(
      currentState,
      "character",
    );
  }
  currentState = consumeRaw(currentState, "'");
  return [`'${literalPart}'`, mkSystemFVar(`__trip_u8_${code}`), currentState];
};

const parseStringLiteralTerm = (
  state: ParserState,
): [string, SystemFTerm, ParserState] => {
  let currentState = consumeRaw(state, '"');
  const literalParts: string[] = [];
  const codes: number[] = [];

  for (let litLen = 0; ; litLen = litLen + 1) {
    if (currentState.idx >= currentState.buf.length) {
      throw new ParseError(
        withParserState(currentState, "unterminated string literal"),
      );
    }
    const ch = currentState.buf[currentState.idx];
    if (ch === '"') {
      currentState = consumeRaw(currentState, '"');
      break;
    }
    if (ch === "\n" || ch === "\r") {
      throw new ParseError(
        withParserState(currentState, "unterminated string literal"),
      );
    }
    let literalPart: string;
    let code: number;
    if (ch === "\\") {
      [literalPart, code, currentState] = parseEscape(
        { buf: currentState.buf, idx: currentState.idx + 1 },
        "string",
      );
    } else {
      [literalPart, code, currentState] = parseLiteralChar(
        currentState,
        "string",
      );
    }
    literalParts.push(literalPart);
    codes.push(code);
  }

  return [`"${literalParts.join("")}"`, buildU8List(codes), currentState];
};

/**
 * Parses an atomic System F term.
 * Atomic terms can be:
 *   - A term abstraction: "\x: T => t"
 *   - A type abstraction: "#X => t"
 *   - A parenthesized term: "(" t ")"
 *   - A match expression: "match <scrutinee> [Type] { | Ctor vars => body ... }"
 *   - A let expression: "let x [: Type] = value in body"
 *   - Literals:
 *     - Numeric literals (e.g. "123")
 *     - Character literals (e.g. "'a'")
 *     - String literals (e.g. "\"ab\"")
 *   - A variable/identifier: e.g. "x"
 *
 * Note: term-level type application `t [T]` is parsed by `parseSystemFTerm` while
 * building an application chain, not as an atom here.
 */
function parseAtomicSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [ch, currentState] = peek(state);

  // 1. Term Abstraction: \x:T => body
  if (ch === BACKSLASH) {
    const stateAfterLambda = matchCh(currentState, BACKSLASH);
    const stateBeforeVar = skipWhitespace(stateAfterLambda);
    const [varLit, stateAfterVar] = parseIdentifier(stateBeforeVar);

    // Explicitly skip whitespace to ensure we hit ':' even if spacing is loose
    const stateBeforeColon = skipWhitespace(stateAfterVar);
    const stateAfterColon = matchCh(stateBeforeColon, ":");

    const stateBeforeType = skipWhitespace(stateAfterColon);
    const [typeLit, typeAnnotation, stateAfterType] =
      parseSystemFType(stateBeforeType);

    const stateBeforeArrow = skipWhitespace(stateAfterType);
    const stateAfterArrow = matchFatArrow(stateBeforeArrow);

    const [bodyLit, bodyTerm, stateAfterBody] =
      parseSystemFTerm(stateAfterArrow);
    return [
      `${BACKSLASH}${varLit}:${typeLit}${FAT_ARROW}${bodyLit}`,
      mkSystemFAbs(varLit, typeAnnotation, bodyTerm),
      stateAfterBody,
    ];
  } // 2. Type Abstraction or U8 literal: #X => body OR #u8(n)
  else if (ch === HASH) {
    const stateAfterHash = matchCh(state, HASH);
    const [nextCh, _stateAfterPeek] = peek(stateAfterHash);

    // Try parsing as #u8(n)
    if (nextCh === "u") {
      try {
        const [id, stateAfterId] = parseIdentifier(stateAfterHash);
        if (id === "u8") {
          const [afterIdCh, stateAfterAfterId] = peek(stateAfterId);
          if (afterIdCh === "(") {
            const stateAfterLP = matchLP(stateAfterAfterId);
            const [lit, val, stateAfterLit] = parseNumericLiteral(stateAfterLP);
            const stateAfterRP = matchRP(stateAfterLit);
            return [
              `#u8(${lit})`,
              mkSystemFVar(`__trip_u8_${val}`),
              stateAfterRP,
            ];
          }
        }
      } catch {
        // Fall through to type abstraction
      }
    }

    const stateBeforeVar = skipWhitespace(stateAfterHash);
    const [typeVar, stateAfterVar] = parseIdentifier(stateBeforeVar);

    const stateBeforeArrow = skipWhitespace(stateAfterVar);
    const stateAfterArrow = matchFatArrow(stateBeforeArrow);

    const [bodyLit, bodyTerm, stateAfterBody] =
      parseSystemFTerm(stateAfterArrow);
    return [
      `${HASH}${typeVar}${FAT_ARROW}${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
      stateAfterBody,
    ];
  } // 3. Parentheses: ( term )
  else if (ch === "(") {
    const stateAfterLP = matchLP(state);
    const [innerLit, innerTerm, stateAfterTerm] =
      parseSystemFTerm(stateAfterLP);
    const stateAfterRP = matchRP(stateAfterTerm);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  }
  // 3.5 List or Pair Literal: { Type | ... } OR { Type1, Type2 | ... }
  else if (ch === "{") {
    let currentState = matchCh(state, LEFT_BRACE);
    currentState = skipWhitespace(currentState);

    // Parse the first type
    const [type1Lit, type1, stateAfterType1] = parseSystemFType(currentState);
    currentState = skipWhitespace(stateAfterType1);

    const [nextCh] = peek(currentState);
    if (nextCh === ",") {
      // It is a Pair Literal!
      currentState = matchCh(currentState, ",");
      currentState = skipWhitespace(currentState);

      // Parse the second type
      const [type2Lit, type2, stateAfterType2] = parseSystemFType(currentState);
      currentState = skipWhitespace(stateAfterType2);

      // Expect '|'
      currentState = matchCh(currentState, "|");
      currentState = skipWhitespace(currentState);

      // Parse the first term (can be a full term since comma-separated)
      const [term1Lit, term1, stateAfterTerm1] = parseSystemFTerm(currentState);
      currentState = skipWhitespace(stateAfterTerm1);

      // Expect ','
      currentState = matchCh(currentState, ",");
      currentState = skipWhitespace(currentState);

      // Parse the second term
      const [term2Lit, term2, stateAfterTerm2] = parseSystemFTerm(currentState);
      currentState = skipWhitespace(stateAfterTerm2);

      // Expect '}'
      const [closing, sAfterInner] = peek(currentState);
      if (closing !== "}") {
        throw new ParseError(
          withParserState(sAfterInner, "expected '}' to close pair literal"),
        );
      }
      currentState = matchCh(currentState, "}");

      // Construct the desugared MkPair application:
      // MkPair [Type1] [Type2] term1 term2
      const mkPairVar = mkSystemFVar("MkPair");
      const typeApp1 = mkSystemFTypeApp(mkPairVar, type1);
      const typeApp2 = mkSystemFTypeApp(typeApp1, type2);
      const app1 = createSystemFApplication(typeApp2, term1);
      const finalTerm = createSystemFApplication(app1, term2);

      const literalStr = `{${type1Lit}, ${type2Lit} | ${term1Lit}, ${term2Lit}}`;
      return [literalStr, finalTerm, currentState];
    } else {
      // It is a List Literal!
      // Expect '|'
      currentState = matchCh(currentState, "|");
      currentState = skipWhitespace(currentState);

      // Parse elements until '}'
      const elementTerms: SystemFTerm[] = [];
      const elementLits: string[] = [];

      while (true) {
        currentState = skipWhitespace(currentState);
        const [nextCh] = peek(currentState);
        if (nextCh === "}") {
          currentState = matchCh(currentState, "}");
          break;
        }
        if (nextCh === null) {
          throw new ParseError(
            withParserState(currentState, "unterminated list literal"),
          );
        }

        const [atomLit, atomTerm, nextState] =
          parseAtomicSystemFTerm(currentState);
        elementLits.push(atomLit);
        elementTerms.push(atomTerm);
        currentState = nextState;
      }

      const finalTerm = buildListLiteral(type1, elementTerms);
      const literalStr = `{${type1Lit} | ${elementLits.join(" ")}}`;
      return [literalStr, finalTerm, currentState];
    }
  } // 4. Literals
  else if (ch === "'") {
    return parseCharLiteralTerm(currentState);
  } else if (ch === '"') {
    return parseStringLiteralTerm(currentState);
  } else if (isDigit(ch)) {
    const [literal, value, stateAfterLiteral] = parseNumericLiteral(state);
    // Values < 256 default to U8 literals; others to Nat
    if (value >= 0n && value <= 255n) {
      return [literal, mkSystemFVar(`__trip_u8_${value}`), stateAfterLiteral];
    }
    return [
      literal,
      mkSystemFVar(makeNatLiteralIdentifier(value)),
      stateAfterLiteral,
    ];
  } // 5. Identifiers and Keywords
  else if (ch !== null && /[a-zA-Z]/.test(ch)) {
    const [varLit, stateAfterVar] = parseIdentifier(state);
    // Only `match` and `let` are treated as term-level keywords at this point:
    // - `match` introduces a `systemF-match` form with its own dedicated parser.
    // - `let` introduces a `systemF-let` form with its own dedicated parser.
    // Other reserved words either don't exist in this surface grammar, are handled
    // contextually inside those parsers (e.g. `in` for let-bindings), or are just
    // ordinary identifiers (variables/constructors) in the AST.
    if (varLit === "match") {
      return parseMatchExpression(stateAfterVar);
    }
    if (varLit === "let") {
      return parseLetExpression(stateAfterVar);
    }
    if (varLit === "cond") {
      return parseCondExpression(stateAfterVar);
    }
    if (varLit === "do") {
      return parseDoExpression(stateAfterVar);
    }
    return [varLit, { kind: "systemF-var", name: varLit }, stateAfterVar];
  } else {
    throw new ParseError(
      withParserState(
        currentState,
        `unexpected token '${ch ?? "EOF"}' while parsing atomic term`,
      ),
    );
  }
}

/**
 * Parses a System F term.
 */
export function parseSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  // 1. Parse the first atom (Head)
  const [headLit, headTerm, headState] = parseAtomicSystemFTerm(state);

  const literals: string[] = [headLit];
  let resultTerm = headTerm;
  let currentState = headState;

  // 2. Loop to parse the tail (Arguments)
  for (let appLength = 0; ; appLength = appLength + 1) {
    currentState = skipWhitespace(currentState);

    // Check strict termination conditions
    if (isTerminator(currentState)) {
      break;
    }

    const [ch, peekState] = peek(currentState);

    // Case A: Type Application [T]
    if (ch === "[") {
      const stateAfterLBracket = matchCh(peekState, "[");
      const stateBeforeType = skipWhitespace(stateAfterLBracket);
      const [typeLit, typeArg, stateAfterType] =
        parseSystemFType(stateBeforeType);
      const stateBeforeRBracket = skipWhitespace(stateAfterType);
      const stateAfterRBracket = matchCh(stateBeforeRBracket, "]");

      literals.push(`[${typeLit}]`);
      resultTerm = mkSystemFTypeApp(resultTerm, typeArg);
      currentState = stateAfterRBracket;
      continue;
    }

    // Case B: Term Application (Next Atom)
    try {
      const [atomLit, atomTerm, nextState] =
        parseAtomicSystemFTerm(currentState);
      literals.push(atomLit);
      resultTerm = createSystemFApplication(resultTerm, atomTerm);
      currentState = nextState;
    } catch (e) {
      throw e;
    }
  }

  const cleanLit = literals.reduce((acc, curr) => {
    if (curr.startsWith("[")) return `${acc}${curr}`;
    return `${acc} ${curr}`;
  });

  return [cleanLit, resultTerm, currentState];
}

export function parseSystemF(input: string): [string, SystemFTerm] {
  const [lit, term] = parseWithEOF(input, parseSystemFTerm);
  return [lit, term];
}

export function unparseSystemF(term: SystemFTerm): string {
  switch (term.kind) {
    case "non-terminal": {
      const parts = flattenSystemFApp(term);
      return `${LEFT_PAREN}${parts
        .map(unparseSystemF)
        .join(" ")}${RIGHT_PAREN}`;
    }
    case "systemF-var": {
      const u8Match = /^__trip_u8_(\d+)$/.exec(term.name);
      if (u8Match) return `#u8(${u8Match[1]})`;
      return parseNatLiteralIdentifier(term.name)?.toString() ?? term.name;
    }
    case "systemF-abs":
      return `${BACKSLASH}${term.name}${COLON}${unparseSystemFType(
        term.typeAnnotation,
      )}${FAT_ARROW}${unparseSystemF(term.body)}`;
    case "systemF-type-abs":
      return `${HASH}${term.typeVar}${FAT_ARROW}${unparseSystemF(term.body)}`;
    case "systemF-type-app": {
      const target =
        term.term.kind === "systemF-var" ||
        term.term.kind === "systemF-type-app" ||
        term.term.kind === "non-terminal"
          ? unparseSystemF(term.term)
          : `${LEFT_PAREN}${unparseSystemF(term.term)}${RIGHT_PAREN}`;
      return `${target}[${unparseSystemFType(term.typeArg)}]`;
    }
    case "systemF-match": {
      const arms = term.arms
        .map(
          (arm) =>
            `| ${arm.constructorName}${
              arm.params.length > 0 ? ` ${arm.params.join(" ")}` : ""
            } ${FAT_ARROW} ${unparseSystemF(arm.body)}`,
        )
        .join(" ");
      return `match ${unparseSystemF(term.scrutinee)} [${unparseSystemFType(
        term.returnType,
      )}] { ${arms} }`;
    }
    case "systemF-let": {
      const ann =
        term.typeAnnotation !== undefined
          ? ` : ${unparseSystemFType(term.typeAnnotation)}`
          : "";
      return `let ${term.name}${ann} = ${unparseSystemF(term.value)} in ${unparseSystemF(
        term.body,
      )}`;
    }
  }
}
