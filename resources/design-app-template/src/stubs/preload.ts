// Stand-ins for the globals the project's preload script exposes
// (contextBridge.exposeInMainWorld). aiden.mock.json's "globals" names them;
// every property is a function that resolves to mockData's entry for its
// path, so real components can render with sample data. Fill mockData below.

declare const __AIDEN_MOCK_GLOBALS__: readonly string[];

/** Sample answers by call path, such as "api.getSettings". A function entry is called with the arguments. */
export const mockData: Record<string, unknown> = {};

/** A deep no-op: any property is another proxy; calling one resolves to mockData[path]. Never thenable. */
export function mockProxy(path: string, data: Record<string, unknown> = mockData): any {
  const callable = function () {};
  return new Proxy(callable, {
    get(_target, key) {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key === "toJSON") return () => ({});
      return mockProxy(path ? `${path}.${key}` : key, data);
    },
    apply(_target, _self, args) {
      const entry = data[path];
      return Promise.resolve(typeof entry === "function" ? entry(...args) : entry);
    },
  });
}

const globals = typeof __AIDEN_MOCK_GLOBALS__ === "undefined" ? [] : __AIDEN_MOCK_GLOBALS__;
for (const name of globals) {
  if (!(name in window)) Object.defineProperty(window, name, { value: mockProxy(name), configurable: true });
}
