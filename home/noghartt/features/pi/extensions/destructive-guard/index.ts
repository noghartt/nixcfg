import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface DestructivePattern {
	label: string;
	pattern: RegExp;
}

const destructivePatterns: DestructivePattern[] = [
	{
		label: "privileged command",
		pattern: /(^|[;&|()\n]\s*)sudo\b/i,
	},
	{
		label: "file or directory deletion",
		pattern: /(^|[;&|()\n]\s*)(?:command\s+)?(?:rm|rmdir|unlink|shred)\b/i,
	},
	{
		label: "find deletion",
		pattern: /\bfind\b[^\n;&|]*\s-delete\b/i,
	},
	{
		label: "filesystem or block-device overwrite",
		pattern: /(^|[;&|()\n]\s*)(?:dd|mkfs(?:\.[\w-]+)?|wipefs|fdisk|sfdisk|parted)\b/i,
	},
	{
		label: "file truncation",
		pattern: /(^|[;&|()\n]\s*)truncate\b/i,
	},
	{
		label: "forced file replacement",
		pattern: /(^|[;&|()\n]\s*)(?:cp|mv)\b[^\n;&|]*(?:-f|--force)\b/i,
	},
	{
		label: "recursive permission or ownership change",
		pattern: /(^|[;&|()\n]\s*)(?:chmod|chown|chgrp)\b[^\n;&|]*(?:-R|--recursive)\b/i,
	},
	{
		label: "Git worktree or history destruction",
		pattern:
			/\bgit\s+(?:(?:reset|clean|restore|rebase)\b|checkout\b[^\n;&|]*\s--(?:\s|$)|branch\b[^\n;&|]*\s-D\b|commit\b[^\n;&|]*--amend\b|stash\s+(?:drop|clear)\b|reflog\s+expire\b)/i,
	},
	{
		label: "destructive Git remote operation",
		pattern: /\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?\b|\s--delete\b|\s:\S+)/i,
	},
	{
		label: "process termination",
		pattern: /(^|[;&|()\n]\s*)(?:kill|killall|pkill)\b/i,
	},
	{
		label: "system shutdown or restart",
		pattern: /(^|[;&|()\n]\s*)(?:shutdown|reboot|halt|poweroff)\b/i,
	},
	{
		label: "service removal or shutdown",
		pattern:
			/\b(?:systemctl\s+(?:disable|mask|stop)|launchctl\s+(?:bootout|remove|unload))\b/i,
	},
	{
		label: "container deletion or pruning",
		pattern:
			/\b(?:docker|podman)\s+(?:(?:container|image|network|volume|system)\s+)?(?:rm|rmi|prune)\b|\bdocker\s+compose\b[^\n;&|]*\sdown\b[^\n;&|]*(?:-v|--volumes)\b/i,
	},
	{
		label: "infrastructure destruction",
		pattern:
			/\bterraform\s+destroy\b|\b(?:kubectl|helm)\s+(?:delete|uninstall)\b|\b(?:aws|gcloud|az)\b[^\n;&|]*\b(?:delete|destroy|terminate)\b/i,
	},
	{
		label: "database destruction",
		pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i,
	},
	{
		label: "package removal",
		pattern:
			/(^|[;&|()\n]\s*)(?:(?:apt(?:-get)?|dnf|yum|pacman|brew|npm|pnpm|yarn|pipx?)\s+(?:remove|uninstall|autoremove)|nix-collect-garbage\b|nix\s+store\s+gc\b)/i,
	},
	{
		label: "system configuration activation",
		pattern: /\b(?:nixos-rebuild|darwin-rebuild|home-manager)\s+switch\b/i,
	},
	{
		label: "write to a protected system or credential path",
		pattern:
			/(?:>|\btee\b)[^\n;&|]*(?:\/(?:etc|usr|bin|sbin|System|nix\/store)\/|~\/\.(?:ssh|gnupg)\/|~\/\.config\/opnix\/)/i,
	},
];

const sensitivePathPatterns = [
	/(^|\/)\.git(?:\/|$)/,
	/(^|\/)\.env(?:\.|\/|$)/i,
	/(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
	/(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)$/i,
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.gnupg(?:\/|$)/,
	/(^|\/)\.config\/opnix(?:\/|$)/,
];

function classifyCommand(command: string): string | undefined {
	return destructivePatterns.find(({ pattern }) => pattern.test(command))?.label;
}

function display(value: string, maxLength = 1200): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n…`;
}

function isWithin(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function canonicalize(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return resolve(path);
		return join(await canonicalize(parent), basename(path));
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== "ENOENT";
	}
}

function isSensitivePath(path: string): boolean {
	return sensitivePathPatterns.some((pattern) => pattern.test(path));
}

async function confirmOrBlock(
	ctx: ExtensionContext,
	title: string,
	details: string,
): Promise<{ block: true; reason: string } | undefined> {
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: `${title} blocked because confirmation is unavailable`,
		};
	}

	const confirmed = await ctx.ui.confirm(title, details);
	if (!confirmed) {
		return { block: true, reason: `${title} declined by user` };
	}

	return undefined;
}

export default function destructiveGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (/(^|[_-])(delete|remove|destroy|drop|truncate|wipe|prune)([_-]|$)/i.test(event.toolName)) {
			return confirmOrBlock(
				ctx,
				"Allow destructive tool?",
				`Tool: ${event.toolName}\nWorking directory: ${ctx.cwd}\n\n${display(JSON.stringify(event.input, null, 2))}`,
			);
		}

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;

			const category = classifyCommand(command);
			if (!category) return undefined;

			return confirmOrBlock(
				ctx,
				"Allow destructive command?",
				`Category: ${category}\nWorking directory: ${ctx.cwd}\n\n${display(command)}`,
			);
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string") return undefined;

		const inputPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
		const resolvedPath = resolve(ctx.cwd, inputPath);
		const [projectRoot, targetPath] = await Promise.all([
			canonicalize(ctx.cwd),
			canonicalize(resolvedPath),
		]);
		const outsideProject = !isWithin(projectRoot, targetPath);
		const sensitive = isSensitivePath(targetPath);
		const overwritesFile = event.toolName === "write" && (await exists(resolvedPath));

		if (!outsideProject && !sensitive && !overwritesFile) return undefined;

		const reasons = [
			outsideProject ? "target is outside the current project" : undefined,
			sensitive ? "target looks sensitive" : undefined,
			overwritesFile ? "write will replace an existing path" : undefined,
		].filter((reason): reason is string => reason !== undefined);

		return confirmOrBlock(
			ctx,
			`Allow ${event.toolName} operation?`,
			`${reasons.join("; ")}\nProject: ${projectRoot}\nTarget: ${targetPath}`,
		);
	});
}
