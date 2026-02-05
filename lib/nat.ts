/**
 * Nat Module - Embedded TripLang Source
 *
 * This file contains the Nat module as a compile-time constant.
 * It gets compiled to a JavaScript object and embedded in the linker.
 */
import type { TripCObject } from "./compiler/objectFile.ts";

const NAT_SOURCE = `module Nat

import Prelude Bool
import Prelude true
import Prelude false
import Prelude Pair
import Prelude pair
import Prelude fst
import Prelude snd
import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude incBin

export Nat
export zero
export succ
export add
export mul
export isZero
export eq
export pred
export sub
export lte
export gte
export toBin
export fromBin

type Nat = #X -> (X -> X) -> X -> X

poly zero = #X => \\s : X -> X => \\z : X => z

poly succ = \\n : Nat =>
  #a => \\s : a -> a => \\z : a =>
    s (n [a] s z)

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

poly toBin = \\n : Nat => n [Bin] incBin BZ

poly rec fromBin = \\b : Bin =>
  match b [Nat] {
    | BZ => zero
    | B0 rest =>
        let r = fromBin rest in
        add r r
    | B1 rest =>
        let r = fromBin rest in
        succ (add r r)
  }`;

/**
 * Compiled Nat object - generated at build time
 * This gets populated by the build process
 */
let NAT_OBJECT: TripCObject | null = null;

/**
 * Initialize the Nat object by compiling the source
 * This should be called once at startup
 */
async function initializeNat(): Promise<void> {
  if (NAT_OBJECT === null) {
    const { compileToObjectFileString } = await import("./compiler/index.ts");
    const { deserializeTripCObject } = await import("./compiler/objectFile.ts");
    const serialized = compileToObjectFileString(NAT_SOURCE);
    NAT_OBJECT = deserializeTripCObject(serialized);
  }
}

/**
 * Get the compiled Nat object
 * Initializes if not already done
 */
export async function getNatObject(): Promise<TripCObject> {
  if (NAT_OBJECT === null) {
    await initializeNat();
  }
  return NAT_OBJECT!;
}
