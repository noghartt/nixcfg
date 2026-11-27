import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	type FileChange,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	type LineScan,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	StreamDecoder,
	type TextLine,
	type TextLineReader,
	toError,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { ExecOptions, Sandbox } from "#sbx/provider.ts";
import { quote } from "#sbx/shell.ts";

/**
 * Durable's `ExecutionEnv` on an sbx `Sandbox`: the coding tools (read, write, edit, bash), spill files and anything else
 * built on the environment land in the sandbox, whatever its provider. Every operation is one remote command (or one
 * `readFile`/`writeFile`), since each is a network round trip: stat and listings are batched into a single script, a
 * small file comes back inline with its metadata when a reader opens it, and errors are classified by the script itself
 * (a `sbx-err:<code>` line on stderr) instead of by a second probe. Paths are POSIX and resolved here against `cwd`, so
 * the scripts only ever see absolute paths.
 *
 * Not supported: `watch` (nothing in pi-durable watches the environment; resources load from the local checkout) and the
 * optional `listFiles`.
 */

/** A file this size or smaller comes back with the reader's open: one round trip for most reads. */
const INLINE_BYTES = 1024 * 1024;
/** Larger files are fetched in chunks this big, base64 over `exec`, and the newest few are kept. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const CACHED_CHUNKS = 4;
/** Spill output reaches the sandbox in appends of about this size. */
const SPILL_BATCH_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/** A file script gets this long before the tool gives up on the sandbox. */
const SCRIPT_DEADLINE_MS = 5 * 60 * 1000;
/** A command gets this long past its timeout (sbx's 10 s kill grace included) before the local wait gives up. */
const EXEC_DEADLINE_GRACE_MS = 30_000;
/** How long one spill write may take. */
const SPILL_DEADLINE_MS = 10 * 60 * 1000;
/** How long cleanup waits for the remote kills of running commands. */
const CLEANUP_WAIT_MS = 5_000;
/** Printed on stderr by a command that never started (missing cwd or program); never shown to the caller. */
const SPAWN_MARK = "sbx-pi-durable-spawn-error:";

const encoder = new TextEncoder();

/**
 * Shell prelude for file scripts: `e <code>` fails with a classified error, and `st` runs stat with a format that works
 * on GNU and BSD stat alike (kind|size|mtime seconds|path).
 */
const PRELUDE = [
	`e() { printf 'sbx-err:%s\\n' "$1" >&2; exit 3; }`,
	`if stat -c %s / >/dev/null 2>&1; then SF=-c; SFMT='%F|%s|%Y|%n'; else SF=-f; SFMT='%HT|%z|%m|%N'; fi`,
].join("\n");

function kindOf(type: string): FileKind | undefined {
	const t = type.toLowerCase();
	if (t.startsWith("regular")) return "file";
	if (t === "directory") return "directory";
	if (t === "symbolic link") return "symlink";
	return undefined;
}

/** One `st` line as a FileInfo; undefined for kinds the interface does not list. */
function parseStat(line: string): FileInfo | undefined {
	const [type, size, mtime, ...rest] = line.split("|");
	const kind = kindOf(type ?? "");
	const path = rest.join("|");
	if (kind === undefined || !path) return undefined;
	return { name: posix.basename(path), path, kind, size: Number(size), mtimeMs: Number(mtime) * 1000 };
}

/** A failed file script's error: the code it printed, else one read from the tool's message. */
function fileError(stderr: string, path: string | undefined): FileError {
	const marked = /sbx-err:(\w+)/u.exec(stderr)?.[1] as FileErrorCode | undefined;
	const message = stderr.replace(/sbx-err:\w+\n?/gu, "").trim();
	if (marked !== undefined) return new FileError(marked, message || marked, path);
	const code: FileErrorCode = /no such file|not found|does not exist/iu.test(stderr)
		? "not_found"
		: /permission denied|operation not permitted|read-only file system/iu.test(stderr)
			? "permission_denied"
			: /not a directory/iu.test(stderr)
				? "not_directory"
				: /is a directory/iu.test(stderr)
					? "is_directory"
					: "unknown";
	return new FileError(code, message || code, path);
}

function aborted<T>(context: Context, path?: string): Result<T, FileError> | undefined {
	return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function isAbort(error: unknown, context: Context): boolean {
	return context.abortSignal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export interface SandboxEnvOptions {
	readonly box: Sandbox;
	/** Absolute home directory on the sandbox (`~` in paths). */
	readonly home: string;
	/** Absolute working directory on the sandbox. */
	readonly cwd: string;
	/** What the system prompt says about the sandbox; see `src/sandbox.ts`. */
	readonly describe?: () => string;
}

export class SandboxExecutionEnv implements ExecutionEnv {
	readonly id: string;
	readonly box: Sandbox;
	readonly home: string;
	cwd: string;
	readonly #describe: (() => string) | undefined;
	/** Commands still running, with their settling, so cleanup can wait (boundedly) for the remote kills. */
	readonly #running = new Map<AbortController, Promise<unknown>>();

	constructor(options: SandboxEnvOptions) {
		this.box = options.box;
		this.home = options.home;
		this.cwd = options.cwd;
		this.#describe = options.describe;
		// One namespace per sandbox: equal ids must see the same files at the same paths.
		this.id = `sbx:${options.box.provider}:${options.box.id}`;
	}

	/** The `sandbox` system-prompt section for conversations in this environment. */
	describe(): string | undefined {
		return this.#describe?.();
	}

	resolve(path: string): string {
		let p = path;
		if (p.startsWith("file://")) p = p.slice("file://".length);
		if (p === "~") return this.home;
		if (p.startsWith("~/")) return posix.join(this.home, p.slice(2));
		return posix.resolve(this.cwd, p);
	}

	/** Runs a file script; stdout on success, a classified error otherwise. */
	async #script(
		body: string,
		path: string | undefined,
		context: Context,
		options: Pick<ExecOptions, "stdin"> = {},
	): Promise<Result<string, FileError>> {
		const stop = aborted<string>(context, path);
		if (stop) return stop;
		// A sandbox that stops answering must not hang a tool forever.
		const deadline = AbortSignal.timeout(SCRIPT_DEADLINE_MS);
		const signal = context.abortSignal === undefined ? deadline : AbortSignal.any([context.abortSignal, deadline]);
		try {
			const result = await this.box.exec(`${PRELUDE}\n${body}`, { ...options, signal });
			if (result.exitCode !== 0) return err(fileError(result.stderr || `exit ${result.exitCode}`, path));
			return ok(result.stdout);
		} catch (error) {
			if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "aborted", path));
			if (deadline.aborted) {
				return err(new FileError("unknown", `the sandbox did not answer within ${SCRIPT_DEADLINE_MS / 1000} s`, path));
			}
			return err(new FileError("unknown", toError(error).message, path, toError(error)));
		}
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const p = quote(this.resolve(path));
		const out = await this.#script(`[ -e ${p} ] || [ -L ${p} ] || e not_found\nstat $SF "$SFMT" -- ${p}`, path, context);
		if (!out.ok) return out;
		const info = parseStat(out.value.trimEnd());
		return info === undefined ? err(new FileError("invalid", "Unsupported file type", this.resolve(path))) : ok(info);
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const p = quote(this.resolve(path));
		const out = await this.#script(`if [ -e ${p} ] || [ -L ${p} ]; then echo yes; else echo no; fi`, path, context);
		return out.ok ? ok(out.value.trim() === "yes") : out;
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		// -H follows the listed directory itself when it is a link; entries gone before stat are skipped.
		const out = await this.#script(
			`[ -e ${p} ] || e not_found\n[ -d ${p} ] || e not_directory\n[ -r ${p} ] || e permission_denied\n` +
				`find -H ${p} -mindepth 1 -maxdepth 1 -exec stat $SF "$SFMT" -- {} + 2>/dev/null\nexit 0`,
			resolved,
			context,
		);
		if (!out.ok) return out;
		const infos: FileInfo[] = [];
		for (const line of out.value.split("\n")) {
			const info = line ? parseStat(line) : undefined;
			if (info !== undefined) infos.push({ ...info, path: posix.join(resolved, info.name) });
		}
		return ok(infos);
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		const out = await this.#script(`[ -e ${p} ] || e not_found\n[ -d ${p} ] || e not_directory`, resolved, context);
		if (!out.ok) return out;
		return ok(new SandboxDirReader(this, resolved));
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		const out = await this.#script(
			`[ -e ${p} ] || e not_found\nrealpath -- ${p} 2>/dev/null || readlink -f -- ${p}`,
			resolved,
			context,
		);
		return out.ok ? ok(out.value.replace(/\n$/u, "")) : out;
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = this.resolve(path);
		const stop = aborted<Uint8Array>(context, resolved);
		if (stop) return stop;
		try {
			return ok(
				await this.box.readFile(resolved, context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			);
		} catch (error) {
			if (isAbort(error, context)) return err(new FileError("aborted", "aborted", resolved));
			// The second round trip only on failure: why it failed.
			const p = quote(resolved);
			const why = await this.#script(
				`[ -e ${p} ] || e not_found\n[ -d ${p} ] && e is_directory\n[ -r ${p} ] || e permission_denied\nexit 1`,
				resolved,
				context,
			);
			return err(why.ok ? new FileError("unknown", toError(error).message, resolved) : why.error);
		}
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		return bytes.ok ? ok(Buffer.from(bytes.value).toString("utf8")) : bytes;
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const reader = await this.openBinaryReader(path, undefined, context);
		return reader.ok ? ok(new SandboxTextLineReader(reader.value, this.resolve(path))) : reader;
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		// A small file comes back inline; a larger one is hard-linked (else copied) to a snapshot, so the reader keeps
		// reading the file it opened when its path is renamed or replaced, as an open file descriptor would.
		const out = await this.#script(
			[
				`[ -e ${p} ] || [ -L ${p} ] || e not_found`,
				...(options?.noFollow === true ? [`[ -L ${p} ] && e invalid`] : []),
				`[ -d ${p} ] && e is_directory`,
				`[ -f ${p} ] || e invalid`,
				`[ -r ${p} ] || e permission_denied`,
				`stat -L $SF "$SFMT" -- ${p}`,
				`size=$(wc -c < ${p} | tr -d ' ')`,
				`if [ "$size" -le ${INLINE_BYTES} ]; then echo inline; base64 < ${p}; exit 0; fi`,
				`snap=$(mktemp "\${TMPDIR:-/tmp}/pi-durable-reader-XXXXXX") || exit 1`,
				`ln -f ${p} "$snap" 2>/dev/null || cp ${p} "$snap" || exit 1`,
				`echo snapshot; echo "$snap"`,
			].join("\n"),
			resolved,
			context,
		);
		if (!out.ok) return out;
		const [statLine = "", mode = "", ...rest] = out.value.split("\n");
		const info = parseStat(statLine);
		if (info === undefined) return err(new FileError("invalid", "Not a regular file", resolved));
		const file = { ...info, name: posix.basename(resolved), path: resolved };
		if (mode === "inline") {
			const bytes = new Uint8Array(Buffer.from(rest.join(""), "base64"));
			return ok(new SandboxBinaryReader(this, { ...file, size: bytes.length }, bytes));
		}
		return ok(new SandboxBinaryReader(this, file, undefined, rest[0]!.trim()));
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const stop = aborted<void>(context, resolved);
		if (stop) return stop;
		try {
			await this.box.writeFile(
				resolved,
				content,
				context.abortSignal === undefined ? {} : { signal: context.abortSignal },
			);
			return ok(undefined);
		} catch (error) {
			if (isAbort(error, context)) return err(new FileError("aborted", "aborted", resolved));
			const p = quote(resolved);
			const why = await this.#script(
				`[ -d ${p} ] && e is_directory\nd=$(dirname -- ${p}); while [ ! -e "$d" ]; do d=$(dirname -- "$d"); done\n` +
					`[ -d "$d" ] || e not_directory\nexit 1`,
				resolved,
				context,
			);
			return err(why.ok ? new FileError("unknown", toError(error).message, resolved) : why.error);
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		const out = await this.#script(
			`[ -d ${p} ] && e is_directory\nmkdir -p -- "$(dirname -- ${p})" && cat >> ${p}`,
			resolved,
			context,
			{ stdin: content },
		);
		return out.ok ? ok(undefined) : out;
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		}
		const p = quote(resolved);
		// dd without conv=notrunc cuts (or extends) the file at the seek offset, on GNU and BSD alike.
		const out = await this.#script(
			`[ -e ${p} ] || e not_found\n[ -d ${p} ] && e is_directory\ndd if=/dev/null of=${p} bs=1 seek=${size} 2>/dev/null`,
			resolved,
			context,
		);
		return out.ok ? ok(undefined) : out;
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		const out = await this.#script(`[ -e ${p} ] || e not_found\n[ -d ${p} ] && e is_directory\nsync`, resolved, context);
		return out.ok ? ok(undefined) : out;
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.resolve(sourcePath);
		// rename(2) of a path onto itself does nothing; the link handling below would delete it.
		if (source === this.resolve(destinationPath)) {
			const there = await this.exists(source, context);
			if (!there.ok) return there;
			return there.value ? ok(undefined) : err(new FileError("not_found", "No such file", source));
		}
		const s = quote(source);
		const d = quote(this.resolve(destinationPath));
		// rename(2), not mv: never moves into an existing directory; replaces an empty one with a directory, and a
		// symbolic link (even one to a directory, which mv would follow) with the source.
		const out = await this.#script(
			[
				`[ -e ${s} ] || [ -L ${s} ] || e not_found`,
				`if [ -L ${d} ]; then rm -f -- ${d} || e unknown`,
				`elif [ -d ${d} ]; then`,
				`  [ -d ${s} ] || e is_directory`,
				`  rmdir -- ${d} 2>/dev/null || e unknown`,
				`fi`,
				`mv -f -- ${s} ${d}`,
			].join("\n"),
			source,
			context,
		);
		return out.ok ? ok(undefined) : out;
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const out = await this.#script(
			`mkdir ${options?.recursive === false ? "" : "-p "}-- ${quote(resolved)}`,
			resolved,
			context,
		);
		return out.ok ? ok(undefined) : out;
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const p = quote(resolved);
		const force = options?.force === true;
		const out = await this.#script(
			[
				...(force ? [] : [`[ -e ${p} ] || [ -L ${p} ] || e not_found`]),
				...(options?.recursive === true ? [] : [`[ -d ${p} ] && [ ! -L ${p} ] && e is_directory`]),
				`rm ${options?.recursive === true ? "-r " : ""}-f -- ${p}`,
			].join("\n"),
			resolved,
			context,
		);
		return out.ok ? ok(undefined) : out;
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const safe = (prefix ?? "tmp-").replace(/[^A-Za-z0-9._-]/gu, "-");
		const out = await this.#script(`mktemp -d "\${TMPDIR:-/tmp}/"${quote(`${safe}XXXXXX`)}`, undefined, context);
		return out.ok ? ok(out.value.trim()) : out;
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const name = `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`.replace(/[/\0]/gu, "-");
		// One round trip: the directory and the empty file.
		const out = await this.#script(
			`d=$(mktemp -d "\${TMPDIR:-/tmp}/tmp-XXXXXX") || exit 1\n: > "$d"/${quote(name)} && printf '%s\\n' "$d"/${quote(name)}`,
			undefined,
			context,
		);
		return out.ok ? ok(out.value.trim()) : out;
	}

	async watch(
		_targets: readonly WatchTarget[],
		_onChange: (change: FileChange) => void,
		_context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "Sandbox environments do not watch files"));
	}

	/** One base64 chunk of a snapshot; internal to the binary reader. */
	async readChunk(snapshot: string, index: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const out = await this.#script(
			`dd if=${quote(snapshot)} bs=${CHUNK_BYTES} skip=${index} count=1 2>/dev/null | base64`,
			snapshot,
			context,
		);
		return out.ok ? ok(new Uint8Array(Buffer.from(out.value, "base64"))) : out;
	}

	async removeQuietly(path: string): Promise<void> {
		await this.box.exec(`rm -f -- ${quote(path)}`).catch(() => undefined);
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
			return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
		}
		const cwd = options?.cwd ? this.resolve(options.cwd) : this.cwd;
		const fresh = options?.inheritEnv === false;
		const vars = Object.entries(options?.env ?? {});
		// Without inherited variables the command sees only `env`, as with Node's spawn; otherwise sbx exports them.
		const envPrefix = fresh ? `env -i ${vars.map(([k, v]) => quote(`${k}=${v}`)).join(" ")} ` : "";
		let run: string;
		if (typeof command === "string") {
			// Models write bash; plain sh only where a sandbox image has no bash.
			run = `if command -v bash >/dev/null 2>&1; then exec ${envPrefix}bash -c ${quote(command)}; else exec ${envPrefix}sh -c ${quote(command)}; fi`;
		} else {
			const [program, ...args] = command;
			if (program === undefined) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
			run =
				`command -v ${quote(program)} >/dev/null 2>&1 || { printf '%s\\n' ${quote(`${SPAWN_MARK}program not found: ${program}`)} >&2; exit 127; }\n` +
				`exec ${envPrefix}${[program, ...args].map(quote).join(" ")}`;
		}
		const script =
			`cd ${quote(cwd)} 2>/dev/null || { printf '%s\\n' ${quote(`${SPAWN_MARK}Working directory does not exist: ${cwd}`)} >&2; exit 127; }\n` +
			run;

		const local = new AbortController();
		const onAbort = () => local.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		let callbackError: ExecutionError | undefined;
		let spawnError: string | undefined;
		const spill = options?.spill === undefined ? undefined : new RemoteSpill(this, options.spill, context);
		const stdout = new ChunkText();
		const stderr = new ChunkText();
		const emit = (text: string, stream: "stdout" | "stderr"): void | Promise<void> => {
			if (text === "" || callbackError !== undefined) return;
			if (stream === "stderr" && text.startsWith(SPAWN_MARK)) {
				spawnError = text.slice(SPAWN_MARK.length).trim();
				return;
			}
			try {
				options?.onOutput?.(text, context, { stream });
			} catch (error) {
				callbackError = new ExecutionError("callback_error", toError(error).message, toError(error));
				// Thrown on to sbx, which then kills the remote process group.
				throw error;
			}
			return spill?.push(text);
		};
		const started = Date.now();
		// sbx enforces the timeout on the sandbox; this is for a sandbox that stops answering altogether.
		let deadlineHit = false;
		const deadline =
			timeout === undefined
				? undefined
				: setTimeout(() => {
						deadlineHit = true;
						local.abort(new Error("the sandbox stopped answering"));
					}, timeout * 1000 + EXEC_DEADLINE_GRACE_MS);
		try {
			const running = this.box.exec(script, {
				signal: local.signal,
				capture: false,
				...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
				...(fresh || vars.length === 0 ? {} : { env: options!.env! }),
				onStdout: (chunk) => emit(stdout.decode(chunk), "stdout"),
				onStderr: (chunk) => emit(stderr.decode(chunk), "stderr"),
			});
			this.#running.set(local, running.catch(() => undefined));
			const result = await running;
			const spillPath = await spill?.finish();
			const attach = (error: ExecutionError) => {
				if (spillPath !== undefined) error.spillPath = spillPath;
				return err<ShellExecResult, ExecutionError>(error);
			};
			if (callbackError !== undefined) return attach(callbackError);
			if (spawnError !== undefined && result.exitCode === 127) return attach(new ExecutionError("spawn_error", spawnError));
			// sbx reports a timeout as 124 (137 past the grace period); a command may exit 124 itself, so the clock decides.
			if (
				timeout !== undefined &&
				(result.exitCode === 124 || result.exitCode === 137) &&
				Date.now() - started >= timeout * 1000 * 0.9
			) {
				return attach(new ExecutionError("timeout", `timeout:${timeout}`));
			}
			if (spill?.error !== undefined) return attach(spill.error);
			return ok({ exitCode: result.exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
		} catch (error) {
			const spillPath = await spill?.finish().catch(() => undefined);
			const failure =
				callbackError ??
				(deadlineHit
					? new ExecutionError("timeout", `timeout:${timeout} (the sandbox stopped answering)`)
					: signal?.aborted === true || local.signal.aborted
					? new ExecutionError("aborted", "aborted")
					: new ExecutionError("unknown", toError(error).message, toError(error)));
			if (spillPath !== undefined) failure.spillPath = spillPath;
			return err(failure);
		} finally {
			if (deadline !== undefined) clearTimeout(deadline);
			signal?.removeEventListener("abort", onAbort);
			this.#running.delete(local);
		}
	}

	async cleanup(_context: Context): Promise<void> {
		// Aborting makes sbx kill each command's remote process group; the kills are waited for, but not forever.
		const running = [...this.#running];
		this.#running.clear();
		for (const [controller] of running) controller.abort(new Error("environment closed"));
		await Promise.race([
			Promise.all(running.map(([, settled]) => settled)),
			new Promise((resolve) => setTimeout(resolve, CLEANUP_WAIT_MS).unref()),
		]);
	}
}

/** sbx hands over decoded strings; this only drops a byte-order mark at the very start, as Durable's decoders do. */
class ChunkText {
	#started = false;
	decode(chunk: string): string {
		if (this.#started || chunk === "") return chunk;
		this.#started = true;
		return chunk.startsWith("\ufeff") ? chunk.slice(1) : chunk;
	}
}

/**
 * Durable's spill on the sandbox: output is counted until it crosses a threshold, then the whole of it goes to a temp
 * file there, in appends of about a megabyte, so the model's `read` finds the file where it reads everything else. The
 * file holds the decoded text: sbx's exec streams strings, not bytes, so invalid UTF-8 arrives as U+FFFD.
 */
class RemoteSpill {
	readonly #env: SandboxExecutionEnv;
	readonly #limits: { afterBytes: number; afterLines: number };
	#prefix: string[] = [];
	#bytes = 0;
	#newlines = 0;
	#pending: string[] = [];
	#pendingBytes = 0;
	#path: Promise<string | undefined> | undefined;
	#chain: Promise<void> = Promise.resolve();
	error: ExecutionError | undefined;

	constructor(env: SandboxExecutionEnv, limits: { afterBytes: number; afterLines: number }, _context: Context) {
		this.#env = env;
		this.#limits = limits;
		// Its own bounded context, not the call's: an aborted or timed-out command's spill must still be completed, as
		// Durable's Node environment completes it.
	}

	/** A fresh bounded context per write. */
	#context(): Context {
		return withAbortSignal(AbortSignal.timeout(SPILL_DEADLINE_MS), BACKGROUND_CONTEXT);
	}

	push(text: string): Promise<void> | undefined {
		if (this.#path === undefined) {
			this.#prefix.push(text);
			this.#bytes += encoder.encode(text).length;
			for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.#newlines++;
			const lines = this.#newlines + (text.endsWith("\n") ? 0 : 1);
			if (this.#bytes <= this.#limits.afterBytes && lines <= this.#limits.afterLines) return undefined;
			this.#path = this.#env.createTempFile({ prefix: "pi-output-", suffix: ".log" }, this.#context()).then((made) => {
				if (made.ok) return made.value;
				this.error = new ExecutionError("unknown", `Failed to preserve complete shell output: ${made.error.message}`);
				return undefined;
			});
			this.#pending = this.#prefix;
			this.#pendingBytes = this.#bytes;
			this.#prefix = [];
			return this.#flush();
		}
		this.#pending.push(text);
		this.#pendingBytes += text.length;
		// Returned to sbx as backpressure: the stream waits while a batch is written.
		return this.#pendingBytes >= SPILL_BATCH_BYTES ? this.#flush() : undefined;
	}

	#flush(): Promise<void> {
		const batch = this.#pending.join("");
		this.#pending = [];
		this.#pendingBytes = 0;
		this.#chain = this.#chain.then(async () => {
			const path = await this.#path;
			if (path === undefined || batch === "" || this.error !== undefined) return;
			const written = await this.#env.appendFile(path, batch, this.#context());
			if (!written.ok) {
				this.error = new ExecutionError("unknown", `Failed to preserve complete shell output: ${written.error.message}`);
			}
		});
		return this.#chain;
	}

	async finish(): Promise<string | undefined> {
		if (this.#path === undefined) return undefined;
		await this.#flush();
		return this.#path;
	}
}

class SandboxBinaryReader implements BinaryReader {
	readonly #env: SandboxExecutionEnv;
	readonly #info: FileInfo;
	readonly #inline: Uint8Array | undefined;
	readonly #snapshot: string | undefined;
	readonly #chunks = new Map<number, Uint8Array>();
	#closed = false;

	constructor(env: SandboxExecutionEnv, info: FileInfo, inline?: Uint8Array, snapshot?: string) {
		this.#env = env;
		this.#info = info;
		this.#inline = inline;
		this.#snapshot = snapshot;
	}

	#check<T>(context: Context): Result<T, FileError> | undefined {
		return (
			aborted<T>(context, this.#info.path) ??
			(this.#closed ? err(new FileError("invalid", "Binary reader is closed", this.#info.path)) : undefined)
		);
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#check<FileInfo>(context) ?? ok(this.#info);
	}

	async #chunk(index: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const cached = this.#chunks.get(index);
		if (cached !== undefined) return ok(cached);
		const fetched = await this.#env.readChunk(this.#snapshot!, index, context);
		if (!fetched.ok) return fetched;
		this.#chunks.set(index, fetched.value);
		if (this.#chunks.size > CACHED_CHUNKS) this.#chunks.delete(this.#chunks.keys().next().value!);
		return fetched;
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const stop = this.#check<Uint8Array>(context);
		if (stop) return stop;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#info.path));
		}
		const end = Math.min(offset + length, this.#info.size);
		if (end <= offset) return ok(new Uint8Array(0));
		if (this.#inline !== undefined) return ok(this.#inline.slice(offset, end));
		const out = new Uint8Array(end - offset);
		for (let position = offset; position < end; ) {
			const index = Math.floor(position / CHUNK_BYTES);
			const chunk = await this.#chunk(index, context);
			if (!chunk.ok) return chunk;
			const from = position - index * CHUNK_BYTES;
			const piece = chunk.value.subarray(from, Math.min(chunk.value.length, from + end - position));
			if (piece.length === 0) return ok(out.subarray(0, position - offset));
			out.set(piece, position - offset);
			position += piece.length;
		}
		return ok(out);
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const stop = this.#check<LineScan>(context);
		if (stop) return stop;
		let scanner: LineScanner;
		try {
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.#info.path));
		}
		if (this.#inline !== undefined) {
			scanner.push(this.#inline);
			return ok(scanner.finish());
		}
		for (let index = 0; index * CHUNK_BYTES < this.#info.size; index++) {
			const chunk = await this.#chunk(index, context);
			if (!chunk.ok) return chunk;
			if (chunk.value.length === 0) break;
			scanner.push(chunk.value);
		}
		return ok(scanner.finish());
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#chunks.clear();
		if (this.#snapshot !== undefined) await this.#env.removeQuietly(this.#snapshot);
	}
}

/** Strict LF lines over a binary reader, as Durable's Node reader reads them. */
class SandboxTextLineReader implements TextLineReader {
	readonly #reader: BinaryReader;
	readonly #path: string;
	readonly #decoder = new StreamDecoder();
	#offset = 0;
	#buffered = "";
	#ended = false;
	#closed = false;

	constructor(reader: BinaryReader, path: string) {
		this.#reader = reader;
		this.#path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const stop = aborted<TextLine | undefined>(context, this.#path);
		if (stop) return stop;
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.#path));
		while (true) {
			const newline = this.#buffered.indexOf("\n");
			if (newline !== -1) {
				const text = this.#buffered.slice(0, newline);
				this.#buffered = this.#buffered.slice(newline + 1);
				return ok({ text, terminated: true });
			}
			if (this.#ended) {
				if (this.#buffered.length === 0) return ok(undefined);
				const text = this.#buffered;
				this.#buffered = "";
				return ok({ text, terminated: false });
			}
			const bytes = await this.#reader.read(this.#offset, 64 * 1024, context);
			if (!bytes.ok) return bytes;
			this.#offset += bytes.value.length;
			if (bytes.value.length === 0) {
				this.#buffered += this.#decoder.decode();
				this.#ended = true;
			} else this.#buffered += this.#decoder.decode(bytes.value);
		}
	}

	async close(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffered = "";
		await this.#reader.close(context);
	}
}

/** Pages of one directory, listed in one round trip when the first page is asked for. */
class SandboxDirReader implements DirReader {
	readonly #env: SandboxExecutionEnv;
	readonly #path: string;
	#entries: FileInfo[] | undefined;
	#closed = false;

	constructor(env: SandboxExecutionEnv, path: string) {
		this.#env = env;
		this.#path = path;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const stop = aborted<{ entries: FileInfo[]; done: boolean }>(context, this.#path);
		if (stop) return stop;
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", this.#path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.#path));
		}
		if (this.#entries === undefined) {
			const listed = await this.#env.listDir(this.#path, context);
			if (!listed.ok) return listed;
			this.#entries = listed.value;
		}
		const entries = this.#entries.splice(0, maxEntries);
		return ok({ entries, done: this.#entries.length === 0 });
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
		this.#entries = [];
	}
}

/**
 * The environment's directory when it is on this machine; undefined for a sandbox. Tools that run local programs (watch,
 * antigravity, research files) fall back to the conversation's own local cwd instead of a path on another machine.
 */
export function localEnvCwd(env: ExecutionEnv | undefined): string | undefined {
	return env === undefined || env instanceof SandboxExecutionEnv ? undefined : env.cwd;
}
