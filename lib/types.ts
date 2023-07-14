import { NonTerminal, nt } from './nonterminal'

export type TypeVariable = {
  kind: 'type-var',
  typeName: string
}

export type Type
  = TypeVariable
  | NonTerminal<Type>

export const mkTypeVar = (name: string): TypeVariable => ({
  kind: 'type-var',
  typeName: name
})

export const arrow = (a: Type, b: Type): Type => nt<Type>(a, b)

// a b c
// a (b c)
// (a (b c))
// NOTE: type application is right associative
export const arrows = (...tys: Type[]): Type => tys.reduceRight(
  (acc, ty) => nt<Type>(ty, acc)
)

export const mono = (ty: Type): boolean => {
  switch (ty.kind) {
    case 'type-var': return true
    case 'non-terminal': return false
  }
}

export const typesEqual = (a: Type, b: Type): boolean => {
  if (a.kind === 'type-var' && b.kind === 'type-var') {
    return a.typeName === b.typeName
  } else if (a.kind === 'non-terminal' && b.kind === 'non-terminal') {
    return typesEqual(a.lft, b.lft) && typesEqual(a.rgt, b.rgt)
  } else {
    return false
  }
}
