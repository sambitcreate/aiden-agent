// Loaded first by test-dom.ts, before anything imports TanStack Router. With
// NODE_ENV unset, Node resolves the router's server build, whose outlets and
// `useRouterState` never follow a navigation; "test" selects the client
// behaviour the app has, so a navigation in a test mounts the routed page.
process.env.NODE_ENV ??= "test";

export {};
