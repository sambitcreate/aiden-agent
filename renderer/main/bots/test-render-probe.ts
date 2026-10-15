// Counts how often given components render, for tests that claim a subtree
// does NOT re-render. It stands in for React DevTools: React DOM hands every
// commit to `__REACT_DEVTOOLS_GLOBAL_HOOK__`, and a component rendered in that
// commit when its fiber was swapped for its alternate and did work, which is
// DevTools' own test. Import it right after `./test-dom`, before anything
// loads `react-dom`, or React never sees the hook.

interface ProbeFiber {
  type: unknown;
  child: ProbeFiber | null;
  sibling: ProbeFiber | null;
  flags: number;
}

/** React's `PerformedWork` flag: the component's function ran and its result was used. */
const PERFORMED_WORK = 1;

const counts = new Map<unknown, number>();
/** Per React root: the tracked fibers in its last committed tree. */
const seenByRoot = new WeakMap<object, Set<ProbeFiber>>();

function walk(fiber: ProbeFiber | null, seen: ReadonlySet<ProbeFiber>, next: Set<ProbeFiber>): void {
  for (let node = fiber; node; node = node.sibling) {
    if (counts.has(node.type)) {
      next.add(node);
      // The same fiber object as last commit: React skipped this subtree entirely.
      if (!seen.has(node) && (node.flags & PERFORMED_WORK) === PERFORMED_WORK) {
        counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
      }
    }
    walk(node.child, seen, next);
  }
}

const holder = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
if (holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ === undefined) {
  holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberRoot: (_renderer: number, root: { current: ProbeFiber }) => {
      if (counts.size === 0) return;
      const next = new Set<ProbeFiber>();
      walk(root.current, seenByRoot.get(root) ?? new Set(), next);
      seenByRoot.set(root, next);
    },
  };
}

/** Starts counting renders of `component`; read the count with the returned function. */
export function countRenders(component: unknown): () => number {
  counts.set(component, 0);
  return () => counts.get(component) ?? 0;
}
