import { parseLambda } from '../parser/untyped'

export const [, predLambda] = parseLambda('λn.λf.λx.n(λg.λh.h(gf))(λu.x)(λu.u)')
