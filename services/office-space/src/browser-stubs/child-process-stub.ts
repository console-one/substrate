/**
 * child-process-stub.ts — Browser-bundle stub for `node:child_process`.
 *
 * @console-one/sequence/v2 tools.ts lazy-imports `node:child_process`
 * inside the `proc.exec` impl. The grant is never mounted in a browser
 * env, but esbuild still resolves the dynamic import specifier at
 * bundle time.
 */

function notAvailable(name: string): never {
  throw new Error(
    `child_process.${name}: not available in the browser. ` +
    `proc.exec only runs in Node envs.`,
  );
}

export function spawn(..._args: unknown[]): never {
  return notAvailable('spawn');
}
export function execFile(..._args: unknown[]): never {
  return notAvailable('execFile');
}

export default new Proxy(
  {},
  {
    get(_t, prop) {
      return notAvailable(String(prop));
    },
  },
);
