import { parseLambda } from "../parser/untyped.ts";

export const [, predLambda] = parseLambda(
  "λn.λf.λx.n(λg.λh.h(g f))(λu.x)(λu.u)",
);
