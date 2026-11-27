import { readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir, type Skill, SettingsManager, stripFrontmatter } from "#pi/index.js";
import { expandPromptTemplate, type PromptTemplate } from "#pi/core/prompt-templates.js";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "#pi/core/trust-manager.js";

/**
 * pi's resources for one directory, loaded by pi's own loader so discovery matches `pi`: skills from the agent dir,
 * `~/.agents/skills`, the project's `.pi/skills` and `.agents/skills` up to the repository root, `skills` settings,
 * and packages; prompt templates; AGENTS.md files. Pi extensions are not loaded (Durable has its own).
 *
 * Project resources follow pi's trust: a saved decision (`trust.json`, written by `pi` or `/trust`), or trusted when
 * the project has nothing that needs trust. An undecided project loads untrusted until `/trust`.
 */
export class PiResources {
	readonly cwd: string;
	readonly agentDir = getAgentDir();
	readonly settings: SettingsManager;
	readonly #trustStore = new ProjectTrustStore(this.agentDir);
	#loader: DefaultResourceLoader;
	#trusted: boolean;
	/** Set when the project needs a trust decision nobody made yet. */
	#undecided: boolean;

	private constructor(cwd: string) {
		this.cwd = cwd;
		const saved = this.#trustStore.get(cwd);
		this.#undecided = saved === null && hasTrustRequiringProjectResources(cwd);
		this.#trusted = saved ?? !this.#undecided;
		this.settings = SettingsManager.create(cwd, this.agentDir, { projectTrusted: this.#trusted });
		this.#loader = this.#createLoader();
	}

	static async load(cwd: string): Promise<PiResources> {
		const resources = new PiResources(cwd);
		await resources.#loader.reload();
		return resources;
	}

	#createLoader(): DefaultResourceLoader {
		return new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settings,
			noExtensions: true,
		});
	}

	get trusted(): boolean {
		return this.#trusted;
	}

	get undecided(): boolean {
		return this.#undecided;
	}

	/** Re-read settings, skills, prompts, and context files from disk. */
	async reload(): Promise<void> {
		await this.settings.reload();
		await this.#loader.reload();
	}

	/** Save trust for this directory, as pi's `/trust` does, and load the project's resources. */
	async trust(): Promise<void> {
		this.#trustStore.set(this.cwd, true);
		this.#trusted = true;
		this.#undecided = false;
		this.settings.setProjectTrusted(true);
		await this.reload();
	}

	get skills(): Skill[] {
		return this.#loader.getSkills().skills;
	}

	get prompts(): PromptTemplate[] {
		return this.#loader.getPrompts().prompts;
	}

	get contextFiles(): Array<{ path: string; content: string }> {
		return this.#loader.getAgentsFiles().agentsFiles;
	}

	get diagnostics(): string[] {
		return [...this.#loader.getSkills().diagnostics, ...this.#loader.getPrompts().diagnostics]
			.filter((diagnostic) => diagnostic.type !== "collision")
			.map((diagnostic) => {
				const message = diagnostic.message.split("\n")[0]!.trim();
				return diagnostic.path ? `${diagnostic.path}: ${message}` : message;
			});
	}

	/**
	 * pi's input expansion: `/skill:name args` becomes the skill block pi writes (rendered collapsed by the TUI), and
	 * `/template args` a prompt template. Anything else is returned as is.
	 */
	expandInput(text: string): string {
		return expandPromptTemplate(this.#expandSkill(text), this.prompts);
	}

	#expandSkill(text: string): string {
		if (!text.startsWith("/skill:")) return text;
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(7) : text.slice(7, space);
		const args = space === -1 ? "" : text.slice(space + 1).trim();
		const skill = this.skills.find((candidate) => candidate.name === name);
		if (skill === undefined) return text;
		const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
		const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args ? `${block}\n\n${args}` : block;
	}
}
