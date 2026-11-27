// Library entry point: the provider contract, the registry with the built-in
// providers registered, and the provider-independent operations on top.
import "./builtin.ts";

export * from "./provider.ts";
export { type ProviderConfig, type SbxConfig, ConfigError, configPath, loadConfig, parseConfig } from "./config.ts";
export { type ProviderContext, type ProviderFactory, kindProblem, registerProvider, registeredProviders, Sbx } from "./registry.ts";
export { type CreateOptions, archiveBranches, createSandbox, pullBranches, seedCheckout } from "./core.ts";
export { type ReapOptions, type ReapResult, busy, lastActivity, pruneArchives, reap, reapable } from "./reap.ts";
export { commandLine, quote } from "./shell.ts";
export { exeProvider, exeFactory, type ExeProviderOptions } from "./providers/exe.ts";
export type { ExeClient, ExeVM } from "./providers/exe-client.ts";
