import { parseLambda } from '../parser/untyped.js';

export const [, predLambda] = parseLambda('λn.λf.λx.n(λg.λh.h(g f))(λu.x)(λu.u)');
