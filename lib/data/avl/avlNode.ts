/**
 *
 * https://en.wikipedia.org/wiki/AVL_tree
 *
 * An Adelson-Velsky and Landis (AVL) tree
 * - `key`: The BST key
 * - `value`: The value associated with that key
 * - `height`: For balancing
 * - `left` & `right`: Pointers to subtrees
 */
export interface AVLNode<TKey, TValue> {
  readonly key: TKey;
  readonly value: TValue;
  readonly height: number;
  readonly left: AVLNode<TKey, TValue> | null;
  readonly right: AVLNode<TKey, TValue> | null;
}

/**
 * An AVL tree is just a reference to the root node (or null if empty).
 */
export interface AVLTree<TKey, TValue> {
  readonly root: AVLNode<TKey, TValue> | null;
}

/**
 * Create an empty AVL tree.
 */
export function createEmptyAVL<TKey, TValue>(): AVLTree<TKey, TValue> {
  return { root: null };
}

/**
 * Create a new AVLNode (immutable).
 */
function createAVLNode<TKey, TValue>(
  key: TKey,
  value: TValue,
  height: number,
  left: AVLNode<TKey, TValue> | null,
  right: AVLNode<TKey, TValue> | null
): AVLNode<TKey, TValue> {
  return { key, value, height, left, right };
}

/** Get a node's height safely. */
function nodeHeight<TKey, TValue>(node: AVLNode<TKey, TValue> | null): number {
  return node ? node.height : 0;
}


/** Recompute a node's height based on its children. */
function recalcHeight<TKey, TValue>(node: AVLNode<TKey, TValue>): AVLNode<TKey, TValue> {
  const h = 1 + Math.max(nodeHeight(node.left), nodeHeight(node.right));
  if (h === node.height) {
    // no change
    return node;
  }
  return createAVLNode(node.key, node.value, h, node.left, node.right);
}

/** Balance factor: height(left) - height(right). */
function balanceFactor<TKey, TValue>(node: AVLNode<TKey, TValue>): number {
  return nodeHeight(node.left) - nodeHeight(node.right);
}

/** Right rotation. */
function rotateRight<TKey, TValue>(y: AVLNode<TKey, TValue>): AVLNode<TKey, TValue> {
  const x = y.left;
  if (!x) return y; // no rotation possible if no left child
  const T2 = x.right;

  // Perform rotation
  const newY = createAVLNode(y.key, y.value, y.height, T2, y.right);
  const newX = createAVLNode(x.key, x.value, x.height, x.left, newY);

  // Recalc heights
  const newY2 = recalcHeight(newY);
  const newX2 = createAVLNode(newX.key, newX.value, newX.height, newX.left, newY2);
  return recalcHeight(newX2);
}

/** Left rotation. */
function rotateLeft<TKey, TValue>(x: AVLNode<TKey, TValue>): AVLNode<TKey, TValue> {
  const y = x.right;
  if (!y) return x;
  const T2 = y.left;

  // Perform rotation
  const newX = createAVLNode(x.key, x.value, x.height, x.left, T2);
  const newY = createAVLNode(y.key, y.value, y.height, newX, y.right);

  const newX2 = recalcHeight(newX);
  const newY2 = createAVLNode(newY.key, newY.value, newY.height, newX2, newY.right);
  return recalcHeight(newY2);
}

/**
 * Insert `(key, value)` into the AVL tree (persistent, immutable).
 *
 * If `key` already exists in the tree, we overwrite its value.
 *
 * @param tree         The original AVL tree.
 * @param key          The key to insert.
 * @param value        The value to insert.
 * @param compareKeys  A comparator for TKey. Return <0 if a<b, 0 if a==b, >0 if a>b.
 * @returns A **new** AVL tree (the old one is not mutated).
 */
export function insertAVL<TKey, TValue>(
  tree: AVLTree<TKey, TValue>,
  key: TKey,
  value: TValue,
  compareKeys: (a: TKey, b: TKey) => number
): AVLTree<TKey, TValue> {
  // Special case: empty tree -> new root
  if (!tree.root) {
    const newRoot = createAVLNode(key, value, 1, null, null);
    return { root: newRoot };
  }

  interface StackItem {
    node: AVLNode<TKey, TValue> | null;
    direction: 'L' | 'R' | null;
  }

  const stack: StackItem[] = [];
  let current: AVLNode<TKey, TValue> | null = tree.root;

  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!current) {
      // We'll insert a new leaf here
      stack.push({ node: null, direction: null });
      break;
    }

    const cmp = compareKeys(key, current.key);
    if (cmp === 0) {
      // Overwrite
      stack.push({ node: current, direction: null });
      break;
    } else if (cmp < 0) {
      // Next move is to the left
      stack.push({ node: current, direction: 'L' });
      if (!current.left) {
        stack.push({ node: null, direction: 'L' });
        break;
      }
      current = current.left;
    } else {
      // Next move is to the right
      stack.push({ node: current, direction: 'R' });
      if (!current.right) {
        stack.push({ node: null, direction: 'R' });
        break;
      }
      current = current.right;
    }
  }

  let newChild: AVLNode<TKey, TValue> | null = null;

  // We have an insertion or overwrite scenario at the top of the stack
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.node === null) {
      // True insertion: create a new leaf node
      newChild = createAVLNode(key, value, 1, null, null);
      stack.pop();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (top.node) {
      // Overwrite
      const node = top.node;
      // Keep left/right, but update the node's value
      const replaced = createAVLNode(node.key, value, node.height, node.left, node.right);
      stack[stack.length - 1] = { node: replaced, direction: top.direction };
    }
  }

  // Now bubble up, rebalancing if needed
  let subtree = newChild;
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top?.node) {
      continue;
    }

    const { node, direction } = top;
    let updated = node;

    if (subtree) {
      // Attach subtree in the correct direction
      const cmp = compareKeys(key, node.key);
      if (cmp === 0) {
        // we replaced this node entirely
        updated = subtree;
      } else {
        if (direction === 'L') {
          updated = createAVLNode(node.key, node.value, node.height, subtree, node.right);
        } else if (direction === 'R') {
          updated = createAVLNode(node.key, node.value, node.height, node.left, subtree);
        }
      }
    }

    updated = recalcHeight(updated);

    // Check balance factor
    const bf = balanceFactor(updated);
    if (bf > 1) {
      // left-heavy
      if (compareKeys(key, updated.left?.key ?? node.key) < 0) {
        // Left-Left
        updated = rotateRight(updated);
      } else {
        // Left-Right
        if (updated.left) {
          const newLeft = rotateLeft(updated.left);
          updated = createAVLNode(updated.key, updated.value, updated.height, newLeft, updated.right);
        }
        updated = rotateRight(updated);
      }
    } else if (bf < -1) {
      // right-heavy
      if (compareKeys(key, updated.right?.key ?? node.key) > 0) {
        // Right-Right
        updated = rotateLeft(updated);
      } else {
        // Right-Left
        if (updated.right) {
          const newRight = rotateRight(updated.right);
          updated = createAVLNode(updated.key, updated.value, updated.height, updated.left, newRight);
        }
        updated = rotateLeft(updated);
      }
    }

    subtree = recalcHeight(updated);
  }

  return { root: subtree };
}

/**
 * Look up a key in the AVL tree. Returns the associated value or undefined if not found.
 */
export function searchAVL<TKey, TValue>(
  tree: AVLTree<TKey, TValue>,
  key: TKey,
  compareKeys: (a: TKey, b: TKey) => number
): TValue | undefined {
  let current = tree.root;
  while (current) {
    const cmp = compareKeys(key, current.key);
    if (cmp === 0) {
      return current.value;
    } else if (cmp < 0) {
      current = current.left;
    } else {
      current = current.right;
    }
  }
  return undefined;
}

/**
 * Return an array of all key-value pairs in ascending key order (in-order traversal).
 */
export function keyValuePairs<TKey, TValue>(
  tree: AVLTree<TKey, TValue>
): [TKey, TValue][] {
  const result: [TKey, TValue][] = [];
  const stack: AVLNode<TKey, TValue>[] = [];

  let current: AVLNode<TKey, TValue> | null = tree.root;

  while (stack.length > 0 || current !== null) {
    // Traverse left subtree
    if (current !== null) {
      stack.push(current);
      current = current.left;
    } else {
      // Pop from stack, add the node's key-value to result,
      // then move to the right subtree
      const node = stack.pop();
      if (node) {
        current = node;
        result.push([current.key, current.value]);
        current = current.right;
      }
    }
  }

  return result;
}
