// Model resolution shared by the daemon, the leader, and members. Like the orchestrator, a pool
// entry lists models in preference order and the first one with credentials wins; only the
// caller knows which have credentials, so this stays free of any registry.

export interface PoolModel {
	key: string;
	models: string[];
	thinking: string;
	tier: number;
}

export interface ModelConfig {
	leader: { models: string[]; thinking: string };
	fallbackMember: string;
	pool: PoolModel[];
}

export interface Choice {
	models: string[];
	thinking: string;
	note: string;
}

export function firstUsable(models: string[], usable: (ref: string) => boolean): string | undefined {
	return models.find(usable);
}

export function fallbackChoice(config: ModelConfig): Choice {
	const entry = config.pool.find((candidate) => candidate.key === config.fallbackMember);
	if (!entry) throw new Error(`fallbackMember "${config.fallbackMember}" is not a pool key`);
	return { models: entry.models, thinking: entry.thinking, note: "default member model" };
}

// A leader-chosen member model is a pool key or a provider/model id.
export function requestedChoice(config: ModelConfig, requested: string): Choice {
	const entry = config.pool.find((candidate) => candidate.key === requested);
	if (entry) return { models: entry.models, thinking: entry.thinking, note: `pool entry ${entry.key}` };
	return { models: [requested], thinking: fallbackChoice(config).thinking, note: "chosen by the leader" };
}
