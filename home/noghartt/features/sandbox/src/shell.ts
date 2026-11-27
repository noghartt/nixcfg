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

/** One `export`, refusing names a shell would misread. */
export function exportLine(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad environment variable name ${name}`);
  return `export ${name}=${quote(value)}`;
}

export function envFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([k, v]) => `${exportLine(k, v)}\n`)
    .join("");
}

export interface WrapOptions {
  /** Identifies the run for `cancelScript`; [a-z0-9] only. */
  id: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Home-relative file to read stdin from (removed afterwards); else /dev/null. */
  stdinFile?: string;
}

/**
 * The script to send. It is wrapped in `sh -c` so the sandbox user's login
 * shell only sees one quoted word; the command runs in its own session, and
 * the wrapper kills that session if its connection dies (HUP, PIPE) or it is
 * signalled, so nothing outlives the request unnoticed.
 */
export function wrapCommand(command: string, options: WrapOptions): string {
  if (!/^[a-z0-9]+$/.test(options.id)) throw new Error(`bad run id ${options.id}`);
  const pidFile = `"${RUN_DIR}/${options.id}"`;
  const input = options.stdinFile ? `"$HOME"/${quote(options.stdinFile)}` : "/dev/null";
  const inner = options.timeoutMs
    ? `timeout -k 10 ${Math.max(1, Math.ceil(options.timeoutMs / 1000))} sh -c ${quote(command)} sbx`
    : `sh -c ${quote(command)} sbx`;
  const cleanup = `rm -f ${pidFile}${options.stdinFile ? ` ${input}` : ""}`;
  const lines = [
    `mkdir -p "${RUN_DIR}"`,
    `cd "$HOME" || exit 1`,
    `[ -f ${ENV_FILE} ] && . ./${ENV_FILE}`,
    ...Object.entries(options.env ?? {}).map(([k, v]) => exportLine(k, v)),
    exportLine("SBX_RUN_ID", options.id),
    ...(options.cwd ? [`cd ${quote(options.cwd)} || exit 1`] : []),
    `sbx_p=`,
    `sbx_stop() { if [ -n "$sbx_p" ]; then kill -TERM -- "-$sbx_p" 2>/dev/null || kill -TERM "$sbx_p" 2>/dev/null; fi; ${cleanup}; }`,
    `trap 'sbx_stop; exit 129' HUP`,
    `trap 'sbx_stop; exit 130' INT`,
    `trap 'sbx_stop; exit 141' PIPE`,
    `trap 'sbx_stop; exit 143' TERM`,
    `if command -v setsid >/dev/null 2>&1; then setsid ${inner} < ${input} & else ${inner} < ${input} & fi`,
    `sbx_p=$!`,
    `echo "$sbx_p" > ${pidFile}`,
    `wait "$sbx_p"; sbx_s=$?`,
    cleanup,
    `exit "$sbx_s"`,
  ];
  return `sh -c ${quote(lines.join("\n"))}`;
}

/** Kills a wrapped run's process group; waits briefly for a run that is still starting. */
export function cancelScript(id: string, waitSeconds = 5): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`bad run id ${id}`);
  const f = `${RUN_DIR}/${id}`;
  const lines = [
    `i=0; while [ ! -f "${f}" ] && [ $i -lt ${waitSeconds * 2} ]; do sleep 0.5; i=$((i+1)); done`,
    `[ -f "${f}" ] || exit 0`,
    `p=$(cat "${f}")`,
    `kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null`,
    `sleep 1`,
    `kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null`,
    `rm -f "${f}"`,
    `exit 0`,
  ];
  return `sh -c ${quote(lines.join("\n"))}`;
}

/** Home-relative directory for buffered stdin, outside the run directory the probe reads. */
export const STDIN_DIR = ".sbx/in";

/** Prints `runs=N users=M`: other wrapped commands still running, and login sessions. */
export const ACTIVITY_SCRIPT = [
  `n=0`,
  `for f in "${RUN_DIR}"/*; do`,
  `  [ -f "$f" ] || continue`,
  `  [ "\${f##*/}" = "$SBX_RUN_ID" ] && continue`,
  `  kill -0 "$(cat "$f")" 2>/dev/null && n=$((n+1))`,
  `done`,
  `echo "runs=$n users=$(who 2>/dev/null | wc -l | tr -d ' ')"`,
].join("\n");
