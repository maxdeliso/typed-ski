export interface NonTerminal <E> {
  kind: 'non-terminal'
  lft: E
  rgt: E
}

/**
 * @param lft the left subtree.
 * @param rgt the right subtree.
 * @returns a new non-terminal node, with E as the type of each branch.
 */
export const nt = <E, >(lft: E, rgt: E): NonTerminal<E> => ({
  kind: 'non-terminal',
  lft,
  rgt
})
