import { parseLambda } from '../parser/untyped.js';

export const [, predLambda] = parseLambda('λn.λf.λx.n(λg.λh.h(gf))(λu.x)(λu.u)');
