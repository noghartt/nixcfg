// Shell scripts sbx sends to sandboxes. Remote commands run through a wrapper
// because closing the connection does not reliably stop them (exe.dev's SDK
// says aborting `ssh` leaves the command running): the wrapper starts the
// command in its own session and records its process group, so cancelling
// is a second request that kills the group, and `timeoutMs` is enforced on
// the sandbox with timeout(1) rather than only by the local wait.

/** One POSIX shell word. */
export function quote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** argv as one shell command line; a single argument is taken as a script. */
export function commandLine(argv: readonly string[]): string {
  return argv.length === 1 ? argv[0] : argv.map(quote).join(" ");
}

export const ENV_FILE = ".sbx/env";
// Under home: always writable, and private to the sandbox's user.
const RUN_DIR = "$HOME/.sbx/run";

export function envFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${quote(v)}\n`)
    .join("");
}

export interface WrapOptions {
  /** Identifies the run for `cancelScript`; [a-z0-9] only. */
  id: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export function wrapCommand(command: string, options: WrapOptions): string {
  if (!/^[a-z0-9]+$/.test(options.id)) throw new Error(`bad run id ${options.id}`);
  const pidFile = `${RUN_DIR}/${options.id}`;
  const inner = options.timeoutMs
    ? `timeout -k 10 ${Math.max(1, Math.ceil(options.timeoutMs / 1000))} sh -c ${quote(command)} sbx`
    : `sh -c ${quote(command)} sbx`;
  const lines = [
    `mkdir -p "${RUN_DIR}"`,
    `cd "$HOME" || exit 1`,
    `[ -f ${ENV_FILE} ] && . ./${ENV_FILE}`,
    ...Object.entries(options.env ?? {}).map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad environment variable name ${k}`);
      return `export ${k}=${quote(v)}`;
    }),
    ...(options.cwd ? [`cd ${quote(options.cwd)} || exit 1`] : []),
    `if command -v setsid >/dev/null 2>&1; then setsid ${inner} & else ${inner} & fi`,
    `sbx_p=$!`,
    `echo "$sbx_p" > "${pidFile}"`,
    `wait "$sbx_p"; sbx_s=$?`,
    `rm -f "${pidFile}"`,
    `exit "$sbx_s"`,
  ];
  return lines.join("\n");
}

/** Kills a wrapped run's process group; waits briefly for a run that is still starting. */
export function cancelScript(id: string): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`bad run id ${id}`);
  const f = `${RUN_DIR}/${id}`;
  return [
    `i=0; while [ ! -f "${f}" ] && [ $i -lt 10 ]; do sleep 0.5; i=$((i+1)); done`,
    `[ -f "${f}" ] || exit 0`,
    `p=$(cat "${f}")`,
    `kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null`,
    `sleep 1`,
    `kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null`,
    `rm -f "${f}"`,
    `exit 0`,
  ].join("\n");
}
