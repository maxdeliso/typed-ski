import { ConsCell, cons } from '../cons.ts';
import { SKIExpression } from '../ski/expression.ts';
import { SKITerminal } from '../ski/terminal.ts';
import { ParseError } from './parseError.ts';

/**
 * A variation on the expression type that allows undefined values.
 * This version is used to build up a syntax expression during parsing,
 * which is then converted into an abstract expression after the parse,
 * while verifying that no undefined values, or 'holes', remain.
 */
type SyntaxExpression
  = SKITerminal
  | ConsCell<SyntaxExpression>
  | undefined;

export class Appendable {
  private syn: SyntaxExpression;
  private insertionSites: ConsCell<SyntaxExpression>[] = [];

  public appendSymbol(term: SKITerminal): void {
    this.appendInternal(term);
  }

  public appendEmptyBranch(): void {
    const newBranch = cons<SyntaxExpression>(undefined, undefined);
    this.appendInternal(newBranch);
    this.insertionSites.push(newBranch);
  }

  private appendInternal(newNode: SyntaxExpression): void {
    if (this.syn === undefined) {
      this.syn = newNode;
      return;
    }

    while (this.insertionSites.length > 0) {
      const top = this.insertionSites.pop();

      if (top === undefined) {
        throw new Error('insertionSites should not have an undefined value');
      } else if (top.lft === undefined) {
        top.lft = newNode;
        this.insertionSites.push(top);
        return;
      } else if (top.rgt === undefined) {
        top.rgt = newNode;
        return;
      }
    }

    let currentNode: SyntaxExpression = this.syn;
    const nodeStack: SyntaxExpression[] = [];

    while (nodeStack.length > 0) {
      // traverse left, accumulating the spine on a stack
      while (currentNode !== undefined) {
        if (currentNode.kind === 'non-terminal') {
          nodeStack.push(currentNode);
          currentNode = currentNode.lft;
        } else {
          // done when a terminal or null is encountered on the left
          break;
        }
      }

      // work through the stack
      currentNode = nodeStack.pop();

      if (currentNode === undefined || currentNode.kind !== 'non-terminal') {
        // if empty or reached a non-terminal, iteration is complete
        break;
      } else if (currentNode.lft === undefined) {
        // if a node has an empty left branch, that's our insert site
        currentNode.lft = newNode;
        return;
      } else if (currentNode.rgt === undefined) {
        // and if it has an empty right branch, insert there
        currentNode.rgt = newNode;
        return;
      } else {
        // otherwise we have a non-empty current node and we iterate right
        currentNode = currentNode.rgt;
      }
    }

    // in this case we traversed the entire expression and there was nowhere to
    // insert, so we add a new root node with the new node as the right subtree
    this.syn = cons(this.syn, newNode);
  }

  /**
   * @param exp a syntax expression.
   * @returns an abstract expression.
   * @throws {ParseError} if there are any empty internal nodes in the
   * expression.
   */
  public flatten(): SKIExpression {
    return this.flattenInternal(this.syn);
  }

  private flattenInternal = (exp: SyntaxExpression): SKIExpression => {
    if (exp === undefined) {
      throw new ParseError('expression undefined (empty)');
    } else if (exp.kind === 'terminal') {
      return exp;
    } else if ((exp.lft === undefined) && (exp.rgt !== undefined)) {
      throw new ParseError('expression lopsided (right)');
    } else if ((exp.lft !== undefined) && (exp.rgt === undefined)) {
      throw new ParseError('expression lopsided (left)');
    } else if ((exp.lft === undefined) || (exp.rgt === undefined)) {
      throw new ParseError('expression undefined (hole)');
    } else {
      return cons(this.flattenInternal(exp.lft), this.flattenInternal(exp.rgt));
    }
  };
}
