/**
 * This is a single term variable with a name.
 *
 * For instance, in the expression "λx:a.y", this is just "y".
 */
export type LambdaVar = {
  kind: 'lambda-var',
  name: string
}

export const mkVar = (name: string): LambdaVar => ({
  kind: 'lambda-var',
  name
})
