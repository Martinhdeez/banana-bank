// FX4-b: preloaded by `npm test`. The route's access log (one `api_request` JSON line per request,
// about half of the output of `npm run verify`) is not printed by the test files. Only the
// printing: the app still calls console.info, so a test that mocks or replaces console.info sees
// every line, and an app a test spawns as a child process logs as always.
const info = console.info;
console.info = (...args: unknown[]) => {
  if (!String(args[0]).includes('"event":"api_request"')) info(...args);
};
