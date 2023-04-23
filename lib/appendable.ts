import { Expression } from './expression'
import { ParseError } from './parser'
import { nt } from './nonterminal'
import { SyntaxExpression } from './syntaxExpression'

export class Appendable {
  private syn: SyntaxExpression
  private restorePoint: SyntaxExpression

  /**
   * @param newNode a (possibly hole-y) syntax expression to append.
   * @returns nothing, manipulates the local state.
   */
  public append (newNode: SyntaxExpression): void {
    if (this.syn === undefined) {
      this.syn = newNode
      return
    }

    let currentNode : SyntaxExpression = this.syn
    const nodeStack : Array<SyntaxExpression> = []

    if (this.restorePoint) {
      currentNode = this.restorePoint
      this.restorePoint = undefined
    }

    while (currentNode !== undefined || nodeStack.length > 0) {
      // traverse left, accumulating the spine on a stack
      while (currentNode !== undefined) {
        if (currentNode.kind === 'non-terminal') {
          nodeStack.push(currentNode)
          currentNode = currentNode.lft
        } else {
          // done when a terminal or null is encountered on the left
          break
        }
      }

      // work through the stack
      currentNode = nodeStack.pop()

      if (currentNode === undefined || currentNode.kind !== 'non-terminal') {
        // if empty or reached a non-terminal, iteration is complete
        break
      } else if (currentNode.lft === undefined) {
        // if a node has an empty left branch, that's our insert site
        currentNode.lft = newNode
        // and cache the current node to restore from as an optimization
        this.restorePoint = currentNode
        return
      } else if (currentNode.rgt === undefined) {
        // and if it has an empty right branch, insert there
        currentNode.rgt = newNode

        // with the restore point being the first insertable node when
        // traversing the node stack in reverse
        for (let i = nodeStack.length - 1; i >= 0; i--) {
          const remaining = nodeStack[i]

          if (this.insertable(remaining)) {
            this.restorePoint = remaining
            break
          }
        }

        return
      } else {
        // otherwise we have a non-empty current node and we iterate right
        currentNode = currentNode.rgt
      }
    }

    // in this case we traversed the entire expression and there was nowhere to
    // insert, so we add a new root node with the new node as the right subtree
    this.syn = nt(this.syn, newNode)
  }

  /**
   * @param exp a syntax expression.
   * @returns an abstract expression.
   * @throws {ParseError} if there are any empty internal nodes in the
   * expression.
   */
  public flatten (): Expression {
    return this.flattenInternal(this.syn)
  }

  /**
   * @param se a syntax expression.
   * @returns true if there is a place to insert into the syntax expression.
   */
  private insertable (se: SyntaxExpression): boolean {
    return se?.kind === 'non-terminal' &&
      (se.lft === undefined || se.rgt === undefined)
  }

  private flattenInternal = (exp: SyntaxExpression): Expression => {
    if (exp === undefined) {
      throw new ParseError('expression undefined (empty)')
    } else if (exp.kind === 'terminal') {
      return exp
    } else if ((exp.lft === undefined) && (exp.rgt !== undefined)) {
      throw new ParseError('expression lopsided (right)')
    } else if ((exp.lft !== undefined) && (exp.rgt === undefined)) {
      throw new ParseError('expression lopsided (left)')
    } else if ((exp.lft === undefined) || (exp.rgt === undefined)) {
      throw new ParseError('expression undefined (hole)')
    } else {
      return nt(this.flattenInternal(exp.lft), this.flattenInternal(exp.rgt))
    }
  }
}
