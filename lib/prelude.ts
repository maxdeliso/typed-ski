/**
 * Prelude Module - Embedded TripLang Source
 *
 * This file contains the prelude module as a compile-time constant.
 * It gets compiled to a JavaScript object and embedded in the linker.
 */
import type { TripCObject } from "./compiler/objectFile.ts";

export const PRELUDE_SOURCE = `module Prelude

export Nat
export Bool
export id
export zero
export succ
export true
export false
export add
export mul
export isZero
export eq
export pair
export fst
export snd
export cond
export readOne
export writeOne

type Nat = ∀X . (X → X) → X → X
type Bool = ∀B . B → B → B

poly id : ∀a.a→a = Λa. λx:a. x

poly zero = ΛX . λs : X → X . λz : X . z

poly succ = λn : Nat .
  Λa . λs : a → a . λz : a .
    s (n [a] s z)

poly true = ΛB . λt : B . λf : B . t
poly false = ΛB . λt : B . λf : B . f

poly add = λm : Nat . λn : Nat .
  Λa . λs : a → a . λz : a .
    m [a] s (n [a] s z)

poly mul = λm : Nat . λn : Nat .
  Λa . λs : a → a . λz : a .
    m [a] (n [a] s) z

poly isZero = λn : Nat .
  n [Bool] (λx : Bool . false) true

poly eq = λm : Nat . λn : Nat .
  ΛX . λs : X → X . λz : X .
    m [X] (λx : X . n [X] (λy : X . x) z) (n [X] (λx : X . z) z)

poly pair = ΛA . ΛB . λa : A . λb : B . ΛY . λk : A → B → Y . k a b

poly fst = ΛA . ΛB . λp : ∀Y . (A→B→Y)→Y .
  p [A] (λx:A . λy:B . x)

poly snd = ΛA . ΛB . λp : ∀Y . (A→B→Y)→Y .
  p [B] (λx:A . λy:B . y)

poly cond = ΛX .
  λb : Bool .
  λt : X .
  λf : X .
    b [X] t f

combinator readOne = ,
combinator writeOne = .`;

/**
 * Compiled prelude object - generated at build time
 * This gets populated by the build process
 */
export let PRELUDE_OBJECT: TripCObject | null = null;

/**
 * Initialize the prelude object by compiling the source
 * This should be called once at startup
 */
export async function initializePrelude(): Promise<void> {
  if (PRELUDE_OBJECT === null) {
    const { compileToObjectFileString } = await import("./compiler/index.ts");
    const { deserializeTripCObject } = await import("./compiler/objectFile.ts");
    const serialized = compileToObjectFileString(PRELUDE_SOURCE);
    PRELUDE_OBJECT = deserializeTripCObject(serialized);
  }
}

/**
 * Get the compiled prelude object
 * Initializes if not already done
 */
export async function getPreludeObject(): Promise<TripCObject> {
  if (PRELUDE_OBJECT === null) {
    await initializePrelude();
  }
  return PRELUDE_OBJECT!;
}
