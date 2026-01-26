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

type Nat = #X -> (X -> X) -> X -> X
type Bool = #B -> B -> B -> B

poly id : #a->a->a = #a => \\x:a => x

poly zero = #X => \\s : X -> X => \\z : X => z

poly succ = \\n : Nat =>
  #a => \\s : a -> a => \\z : a =>
    s (n [a] s z)

poly true = #B => \\t : B => \\f : B => t
poly false = #B => \\t : B => \\f : B => f

poly add = \\m : Nat => \\n : Nat =>
  #a => \\s : a -> a => \\z : a =>
    m [a] s (n [a] s z)

poly mul = \\m : Nat => \\n : Nat =>
  #a => \\s : a -> a => \\z : a =>
    m [a] (n [a] s) z

poly isZero = \\n : Nat =>
  n [Bool] (\\x : Bool => false) true

poly eq = \\m : Nat => \\n : Nat =>
  #X => \\s : X -> X => \\z : X =>
    m [X] (\\x : X => n [X] (\\y : X => x) z) (n [X] (\\x : X => z) z)

poly pair = #A => #B => \\a : A => \\b : B => #Y => \\k : A -> B -> Y => k a b

poly fst = #A => #B => \\p : #Y -> (A->B->Y)->Y =>
  p [A] (\\x:A => \\y:B => x)

poly snd = #A => #B => \\p : #Y -> (A->B->Y)->Y =>
  p [B] (\\x:A => \\y:B => y)

poly cond = #X =>
  \\b : Bool =>
  \\t : X =>
  \\f : X =>
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
