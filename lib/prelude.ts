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
export not
export and
export or
export pred
export sub
export lte
export gte
export readOne
export writeOne
export List
export nil
export cons
export matchList
export head
export tail
export error
export Pair
export MkPair
export Result
export Err
export Ok
export ParseError
export MkParseError
export Parser
export append
export map
export foldl
export takeWhile
export dropWhile

type Nat = #X -> (X -> X) -> X -> X
type Bool = #B -> B -> B -> B
type List = #A -> #R -> R -> (A -> R -> R) -> R
data Pair A B = MkPair A B
data Result E T = Err E | Ok T
data ParseError = MkParseError Nat (List Nat)
type Parser = #A -> List Nat -> Result ParseError (Pair A (List Nat))

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

poly not = \\b : Bool => cond [Bool] b false true

poly and = \\a : Bool => \\b : Bool => cond [Bool] a b false

poly or = \\a : Bool => \\b : Bool => cond [Bool] a true b

poly pred = \\n : Nat =>
  fst [Nat] [Nat]
    ( n [#Y -> (Nat -> Nat -> Y) -> Y]
        ( \\p : #Y -> (Nat -> Nat -> Y) -> Y =>
            pair [Nat] [Nat]
              (snd [Nat] [Nat] p)
              (succ (snd [Nat] [Nat] p))
        )
        (pair [Nat] [Nat] zero zero)
    )

poly sub = \\a : Nat => \\b : Nat => b [Nat] pred a

poly lte = \\a : Nat => \\b : Nat => isZero (sub a b)

poly gte = \\a : Nat => \\b : Nat => lte b a

poly nil = #A => #R => \\n : R => \\c : (A -> List -> R) => n

poly cons = #A => \\x : A => \\xs : List =>
  #R => \\n : R => \\c : (A -> List -> R) => c x xs

poly matchList = #A => #R => \\l : List => \\onNil : R =>
  \\onCons : (A -> List -> R) =>
    l [R] onNil onCons

poly head = #A => \\l : List =>
  l [A] error (\\h : A => \\t : List => h)

poly tail = #A => \\l : List =>
  l [List] (nil [A]) (\\h : A => \\t : List => t)

poly rec append = #A => \\xs : List => \\ys : List =>
  matchList [A] [List] xs ys
    (\\h : A => \\t : List => cons [A] h (append [A] t ys))

poly rec map = #A => #B => \\f : A -> B => \\l : List =>
  matchList [A] [List] l (nil [B])
    (\\h : A => \\t : List => cons [B] (f h) (map [A] [B] f t))

poly rec foldl = #A => #B => \\f : B -> A -> B => \\acc : B => \\l : List =>
  matchList [A] [B] l acc
    (\\h : A => \\t : List => foldl [A] [B] f (f acc h) t)

poly rec takeWhile = #A => \\p : A -> Bool => \\l : List =>
  matchList [A] [List] l (nil [A])
    (\\h : A => \\t : List =>
      cond [List] (p h)
        (cons [A] h (takeWhile [A] p t))
        (nil [A]))

poly rec dropWhile = #A => \\p : A -> Bool => \\l : List =>
  matchList [A] [List] l (nil [A])
    (\\h : A => \\t : List =>
      cond [List] (p h)
        (dropWhile [A] p t)
        (cons [A] h t))

poly error = #A =>
  (\\x : A => x) (\\x : A => x)

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
