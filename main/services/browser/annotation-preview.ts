/** User-only annotation styling. Execute these expressions in the browser's isolated world. */
export interface BrowserAnnotationPreviewInput {
  ref: string;
  selector: string;
  styles: Record<string, string>;
}

export interface BrowserAnnotationPreviewChange {
  ref: string;
  selector: string;
  changes: Record<string, { previous: string; current: string }>;
}

const MAX_TARGETS = 50;
const MAX_PROPERTIES = 40;

function inputs(
  value: readonly BrowserAnnotationPreviewInput[],
): BrowserAnnotationPreviewInput[] {
  if (!Array.isArray(value) || value.length > MAX_TARGETS)
    throw new Error("Preview at most 50 selected elements at once.");
  const selectors = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.ref !== "string" ||
      !item.ref ||
      item.ref.length > 100 ||
      typeof item.selector !== "string" ||
      !item.selector.trim() ||
      item.selector.length > 4000
    )
      throw new Error(
        "Every style preview needs a valid element reference and selector.",
      );
    if (selectors.has(item.selector))
      throw new Error("Preview each element selector only once.");
    selectors.add(item.selector);
    if (
      !item.styles ||
      typeof item.styles !== "object" ||
      Array.isArray(item.styles)
    )
      throw new Error("Element styles must be a property and value map.");
    const entries = Object.entries(item.styles);
    if (entries.length > MAX_PROPERTIES)
      throw new Error("Preview at most 40 styles per element.");
    const styles: Record<string, string> = Object.create(null);
    for (const [property, next] of entries) {
      if (
        property.length > 100 ||
        !/^(?:--[a-zA-Z_][a-zA-Z\d_-]*|-?[a-zA-Z][a-zA-Z\d-]*)$/.test(
          property,
        ) ||
        typeof next !== "string" ||
        next.length > 2000 ||
        next.includes("\0")
      )
        throw new Error(
          "Provide a valid CSS property and a value under 2000 characters.",
        );
      const normalized = property.startsWith("--")
        ? property
        : property.toLowerCase();
      // Removing an editor value removes its preview and restores the original declaration.
      if (next.trim()) styles[normalized] = next.trim();
    }
    return { ref: item.ref, selector: item.selector, styles };
  });
}

// Stored in an isolated execution context, separately for each frame. The page never
// receives this state or an application bridge. Everything is synchronous so an update
// cannot leave half the selected elements changed when a selector or value is invalid.
const PAGE_RUNTIME = String.raw`
  const stateKey = '__aidenBrowserAnnotationPreview_v1';
  const state = globalThis[stateKey] || { entries: new Map() };
  const readInline = element => {
    const values = new Map();
    for (let i = 0; i < element.style.length; i++) {
      const property = element.style.item(i);
      values.set(property, { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) });
    }
    return values;
  };
  const equal = (a, b) => a?.value === b?.value && a?.priority === b?.priority;
  const writeInline = (element, values) => {
    element.style.cssText = '';
    for (const [property, original] of values) element.style.setProperty(property, original.value, original.priority);
  };
  const originalNow = (element, entry) => {
    if (!entry) return readInline(element);
    // An aborted DevTools evaluation can stop between two style writes. Its
    // pre-published baseline remains sufficient for the next reset to recover.
    if (entry.pending) return new Map(entry.original);
    const original = new Map(entry.original);
    const current = readInline(element);
    // Preserve unrelated inline changes made by the page while annotation is open.
    // Preview-affected declarations keep their pre-preview value and priority.
    for (const property of new Set([...current.keys(), ...entry.applied.keys()])) {
      if (entry.affected.has(property) || equal(current.get(property), entry.applied.get(property))) continue;
      if (current.has(property)) original.set(property, current.get(property));
      else original.delete(property);
    }
    return original;
  };
  const resolve = selector => {
    const injected = globalThis.__aidenPlaywright;
    const matches = injected
      ? injected.querySelectorAll(injected.parseSelector(selector), document)
      : [...document.querySelectorAll(selector)];
    if (matches.length !== 1) throw new Error('The selected style target must match exactly one element. Select it again.');
    const element = matches[0];
    if (!element.isConnected || !element.style) throw new Error('The selected element no longer supports style preview.');
    return element;
  };
  const apply = inputs => {
    const targets = new Set();
    const plans = inputs.filter(input => Object.keys(input.styles).length).map(input => {
      const element = resolve(input.selector);
      if (targets.has(element)) throw new Error('Two selectors identify the same style target. Select it only once.');
      targets.add(element);
      for (const [property, value] of Object.entries(input.styles)) {
        if (!CSS.supports(property, value)) throw new Error('Unsupported CSS value for ' + property + '.');
      }
      return { input, element };
    });
    const all = new Set([...state.entries.keys(), ...targets]);
    const rollback = new Map([...all].map(element => [element, element.style.cssText]));
    const originals = new Map([...all].map(element => [element, originalNow(element, state.entries.get(element))]));
    const next = new Map();
    const results = [];
    if (all.size) globalThis[stateKey] = { entries: new Map([...all].map(element => [element, {
      original: originals.get(element), previous: state.entries.get(element)?.previous || new Map(), pending: true
    }])) };
    try {
      // Restoring before reapplying also handles CSS shorthand/longhand interactions.
      for (const element of all) writeInline(element, originals.get(element));
      const previous = new Map(plans.map(({ input, element }) => {
        const old = state.entries.get(element);
        const computed = getComputedStyle(element);
        return [element, new Map(Object.keys(input.styles).map(property => [property, old?.previous.get(property) ?? computed.getPropertyValue(property)]))];
      }));
      for (const { input, element } of plans) {
        const changes = Object.create(null);
        for (const [property, value] of Object.entries(input.styles)) {
          element.style.setProperty(property, value, 'important');
          changes[property] = { previous: previous.get(element).get(property), current: element.style.getPropertyValue(property) };
        }
        const applied = readInline(element);
        const original = originals.get(element);
        const affected = new Set(Object.keys(input.styles));
        for (const property of new Set([...original.keys(), ...applied.keys()])) {
          if (!equal(original.get(property), applied.get(property))) affected.add(property);
        }
        next.set(element, { original, applied, affected, previous: previous.get(element) });
        results.push({ ref: input.ref, selector: input.selector, changes });
      }
      if (next.size) globalThis[stateKey] = { entries: next };
      else delete globalThis[stateKey];
      return results;
    } catch (error) {
      for (const [element, cssText] of rollback) element.style.cssText = cssText;
      if (state.entries.size) globalThis[stateKey] = state;
      else delete globalThis[stateKey];
      throw error;
    }
  };
`;

/** Complete desired styles; omitted targets/properties are restored automatically. */
export function buildBrowserAnnotationPreviewApplyExpression(
  changes: readonly BrowserAnnotationPreviewInput[],
): string {
  return `(() => {${PAGE_RUNTIME}\nreturn apply(${JSON.stringify(inputs(changes))});\n})()`;
}

/** Safe to repeat, including after navigation destroyed the original page state. */
export function buildBrowserAnnotationPreviewResetExpression(): string {
  return `(() => {${PAGE_RUNTIME}\napply([]); return undefined;\n})()`;
}

export class BrowserAnnotationPreview {
  constructor(
    private readonly executor: {
      execute: (expression: string) => Promise<unknown>;
    },
  ) {}

  async apply(
    changes: readonly BrowserAnnotationPreviewInput[],
  ): Promise<BrowserAnnotationPreviewChange[]> {
    return (await this.executor.execute(
      buildBrowserAnnotationPreviewApplyExpression(changes),
    )) as BrowserAnnotationPreviewChange[];
  }

  async reset(): Promise<void> {
    await this.executor.execute(buildBrowserAnnotationPreviewResetExpression());
  }
}
