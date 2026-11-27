import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	createRegistry,
	type EnvTarget,
	type HarnessSettings,
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { applyHttpProxySettings, configureHttpDispatcher } from "#pi/core/http-dispatcher.js";
import { findInitialModel, resolveCliModel } from "#pi/core/model-resolver.js";
import type { ModelRuntime } from "#pi/core/model-runtime.js";
import type { SettingsManager } from "#pi/core/settings-manager.js";
import { createPiPrompt } from "./prompt.ts";
import type { PiResources } from "./resources.ts";
import { type Sandboxes, sandboxOf } from "./sandbox.ts";

/** pi's HTTP setup: proxy, idle timeouts, and one undici for fetch. Without it, some provider streams break off. */
export function configureHarnessHttp(settingsManager: SettingsManager): void {
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Harness settings read at every use from pi's settings as loaded at startup. */
export function createHarnessSettings(settingsManager: SettingsManager): HarnessSettings {
	return {
		get stream() {
			const provider = settingsManager.getProviderRetrySettings();
			const idle = settingsManager.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get compaction() {
			return settingsManager.getCompactionSettings();
		},
		get retry() {
			return settingsManager.getRetrySettings();
		},
		get steeringMode() {
			return settingsManager.getSteeringMode();
		},
		get followUpMode() {
			return settingsManager.getFollowUpMode();
		},
	};
}

/** A registry with pi's coding tools and system prompt. */
export function createCodingRegistry(resources: PiResources): Registry {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createPiPrompt(resources));
	return registry;
}

/**
 * One execution environment per directory, shared by every conversation in it. A conversation in a sandbox (its own, or
 * the session's) gets the sandbox's environment instead, at the place its local directory maps to there
 * (`src/sandbox.ts`); its agent `cwd` stays local, so detaching the sandbox needs no change to the conversation.
 */
export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #envs = new Map<string, NodeExecutionEnv>();
	readonly #sandboxes: Sandboxes | undefined;

	constructor(defaultCwd: string, sandboxes?: Sandboxes) {
		this.#defaultCwd = defaultCwd;
		this.#sandboxes = sandboxes;
	}

	readonly env = async (target: EnvTarget, context: Context): Promise<ExecutionEnv> => {
		const cwd = target.cwd ?? this.#defaultCwd;
		if (this.#sandboxes !== undefined) {
			const ref = await sandboxOf(target.read, target.conversationId, context);
			if (ref !== undefined) return this.#sandboxes.env(ref, cwd);
		}
		return this.local(cwd);
	};

	local(cwd: string): NodeExecutionEnv {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	}

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		this.#envs.clear();
		for (const env of envs) await env.cleanup(context);
		await this.#sandboxes?.cleanup(context);
	}
}

export interface InitialModel {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly fallbackMessage?: string;
}

/** The model a new root conversation starts with: an explicit `--provider`/`--model`, or pi's default resolution. */
export async function findInitialAgentModel(
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	cli?: { readonly provider?: string; readonly model: string },
): Promise<InitialModel> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({ cliProvider: cli.provider, cliModel: cli.model, modelRuntime });
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
		}
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
		};
	}
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModelId: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		modelRuntime,
	});
	return {
		...(initial.model === undefined
			? {}
			: {
					model: { provider: initial.model.provider, modelId: initial.model.id },
					thinkingLevel: initial.thinkingLevel,
				}),
		...(initial.fallbackMessage === undefined ? {} : { fallbackMessage: initial.fallbackMessage }),
	};
}
