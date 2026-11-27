// proper-lockfile ships no types; only `lock` and `check` are used.
declare module "proper-lockfile" {
	interface LockOptions {
		realpath?: boolean;
		stale?: number;
		retries?: { retries: number; minTimeout: number; maxTimeout: number };
	}
	const lockfile: {
		lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
		check(file: string, options?: Omit<LockOptions, "retries">): Promise<boolean>;
	};
	export default lockfile;
}
