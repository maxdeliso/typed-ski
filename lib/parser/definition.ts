export const POLY = "poly" as const;
export const TYPED = "typed" as const;
export const UNTYPED = "untyped" as const;
export const COMBINATOR = "combinator" as const;
export const TYPE = "type" as const;
export const DATA = "data" as const;
export const MODULE = "module" as const;
export const IMPORT = "import" as const;
export const EXPORT = "export" as const;

export const DEFINITION_KEYWORDS = [
  POLY,
  TYPED,
  UNTYPED,
  COMBINATOR,
  TYPE,
  DATA,
  MODULE,
  IMPORT,
  EXPORT,
] as const;

export type DefinitionKind = typeof DEFINITION_KEYWORDS[number];
