import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SlashCommandInfo, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, fuzzyFilter, matchesKey, renderFakeCursor, truncateToWidth, type AutocompleteProvider, type Focusable, type TUI, visibleWidth } from "@earendil-works/pi-tui";

type SkillCommand = SlashCommandInfo & { source: "skill" };
type SkillUsage = { uses: number; lastUsedAt: number };

const usagePath = join(homedir(), ".pi", "agent", "skills-usage.json");
const skillUsage = loadSkillUsage();

function skillName(command: SkillCommand): string {
	return command.name.replace(/^skill:/, "");
}

function searchSkills(skills: SkillCommand[], query: string): SkillCommand[] {
	// Browsing favours habits; searching must favour what was typed. `fuzzyFilter`
	// already ranks exact and tighter matches ahead of broad description matches.
	if (!query.trim()) return [...skills].sort(compareSkillUsage);
	return fuzzyFilter(skills, query, (skill) => `${skillName(skill)} ${skill.description ?? ""}`);
}

function displaySkill(skill: SkillCommand): string {
	return `${skillName(skill)} — ${skill.description ?? "No description"}`;
}

export default function betterSkills(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => hideNativeSkillCommands(current));
	});

	pi.on("input", (event) => {
		// Direct native invocations do not pass through /skills. The palette records
		// its own extension-originated invocation below, so do not double-count it.
		if (event.source !== "extension") {
			const match = event.text.match(/^\/skill:([^\s/]+)(?:\s|$)/);
			if (match) recordSkillUse(match[1]!);
		}
		return { action: "continue" };
	});

	pi.registerCommand("skills", {
		description: "Open a fuzzy-searchable skill palette and run one with a task",
		getArgumentCompletions: (prefix) => searchSkills(getSkills(pi), prefix).map((skill) => ({
			value: skillName(skill),
			label: skillName(skill),
			description: skill.description,
		})),
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to finish before opening the skills palette.", "warning");
				return;
			}

			const skills = getSkills(pi);
			if (skills.length === 0) {
				ctx.ui.notify("No skills are available in this directory.", "info");
				return;
			}

			const skill = await chooseSkill(skills, args.trim(), ctx);
			if (!skill) return;

			const task = await ctx.ui.input(`Run skill: ${skillName(skill)}`, "What should it do? (optional)");
			if (task === undefined) return;

			recordSkillUse(skillName(skill));
			const command = `/skill:${skillName(skill)}${task.trim() ? ` ${task.trim()}` : ""}`;
			await pi.sendUserMessage(command, { expandPromptTemplates: true });
		},
	});
}

async function chooseSkill(skills: SkillCommand[], initialQuery: string, ctx: ExtensionCommandContext): Promise<SkillCommand | undefined> {
	if (ctx.mode === "tui") {
		const selectedName = await ctx.ui.custom<string | undefined>(
			(tui, theme, _keybindings, done) => new SkillsPaletteComponent(tui, skills, initialQuery, theme, done),
		);
		return skills.find((skill) => skillName(skill) === selectedName);
	}

	const query = initialQuery || await ctx.ui.input("Search skills", "Name or description");
	if (query === undefined) return undefined;
	const matches = searchSkills(skills, query);
	if (matches.length === 0) {
		ctx.ui.notify(`No skills match ${JSON.stringify(query)}.`, "info");
		return undefined;
	}
	const options = matches.map(displaySkill);
	const selected = matches.length === 1 ? options[0] : await ctx.ui.select("Skills", options);
	return selected ? matches[options.indexOf(selected)] : undefined;
}

function getSkills(pi: ExtensionAPI): SkillCommand[] {
	return pi.getCommands()
		.filter((command): command is SkillCommand => command.source === "skill")
		.sort(compareSkillUsage);
}

class SkillsPaletteComponent implements Focusable {
	focused = false;

	private query: string;
	private cursor: number;
	private selected = 0;
	private filtered: SkillCommand[];

	constructor(
		private readonly tui: TUI,
		private readonly skills: SkillCommand[],
		initialQuery: string,
		private readonly theme: Theme,
		private readonly done: (skillName: string | undefined) => void,
	) {
		this.query = initialQuery;
		this.cursor = initialQuery.length;
		this.filtered = [];
		this.updateMatches();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.done(undefined);
		if (matchesKey(data, "return")) {
			const skill = this.filtered[this.selected];
			return this.done(skill ? skillName(skill) : undefined);
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor === 0) return;
			this.query = this.query.slice(0, this.cursor - 1) + this.query.slice(this.cursor);
			this.cursor--;
			this.updateMatches();
			return;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.query.length, this.cursor + 1);
			this.tui.requestRender();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query = this.query.slice(0, this.cursor) + data + this.query.slice(this.cursor);
			this.cursor++;
			this.updateMatches();
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(0, width - 2);
		const row = (content: string) => this.theme.fg("border", "│") + pad(content, innerWidth) + this.theme.fg("border", "│");
		const cursorChar = this.cursor < this.query.length ? this.query[this.cursor] : " ";
		const query = `${this.query.slice(0, this.cursor)}${this.focused ? CURSOR_MARKER : ""}${renderFakeCursor(cursorChar)}${this.query.slice(this.cursor + 1)}`;
		const lines = [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			row(` ${this.theme.fg("accent", this.theme.bold("Skills"))} ${this.theme.fg("dim", "type to filter · ↑↓ navigate · Enter select · Esc cancel")}`),
			row(` ${this.theme.fg("dim", "Search:")} ${query}`),
			row(""),
		];

		const start = Math.min(Math.max(0, this.selected - 5), Math.max(0, this.filtered.length - 10));
		const visible = this.filtered.slice(start, start + 10);
		if (visible.length === 0) lines.push(row(` ${this.theme.fg("dim", "No matching skills")}`));
		for (let index = 0; index < visible.length; index++) {
			const skill = visible[index]!;
			const selected = start + index === this.selected;
			const prefix = selected ? this.theme.fg("accent", " › ") : "   ";
			const name = selected ? this.theme.fg("accent", skillName(skill)) : this.theme.fg("text", skillName(skill));
			const description = truncate(skill.description ?? "No description", 70);
			lines.push(row(`${prefix}${name} ${this.theme.fg("dim", "— " + description)}`));
		}
		if (this.filtered.length > visible.length) lines.push(row(` ${this.theme.fg("dim", `${start + 1}-${start + visible.length} of ${this.filtered.length} matches`)}`));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}

	private updateMatches(): void {
		this.filtered = searchSkills(this.skills, this.query);
		this.selected = 0;
		this.tui.requestRender();
	}
}

function hideNativeSkillCommands(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...current,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			const commandText = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
			if (!suggestions || !commandText.startsWith("/") || commandText.includes(" ")) return suggestions;

			const items = suggestions.items.filter((item) => !item.value.startsWith("skill:"));
			return items.length > 0 ? { ...suggestions, items } : null;
		},
	};
}

function compareSkillUsage(a: SkillCommand, b: SkillCommand): number {
	const aUsage = skillUsage[skillName(a)];
	const bUsage = skillUsage[skillName(b)];
	if ((bUsage?.lastUsedAt ?? 0) !== (aUsage?.lastUsedAt ?? 0)) return (bUsage?.lastUsedAt ?? 0) - (aUsage?.lastUsedAt ?? 0);
	if ((bUsage?.uses ?? 0) !== (aUsage?.uses ?? 0)) return (bUsage?.uses ?? 0) - (aUsage?.uses ?? 0);
	return skillName(a).localeCompare(skillName(b));
}

function loadSkillUsage(): Record<string, SkillUsage> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(usagePath, "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		const skills = (parsed as { skills?: unknown }).skills;
		if (!skills || typeof skills !== "object") return {};
		return Object.fromEntries(
			Object.entries(skills).filter(([, value]): value is [string, SkillUsage] =>
				Boolean(value) && typeof value === "object" &&
				typeof (value as SkillUsage).uses === "number" &&
				typeof (value as SkillUsage).lastUsedAt === "number",
			),
		);
	} catch {
		return {};
	}
}

function recordSkillUse(name: string): void {
	const previous = skillUsage[name];
	skillUsage[name] = { uses: (previous?.uses ?? 0) + 1, lastUsedAt: Date.now() };
	try {
		fs.mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		fs.writeFileSync(usagePath, JSON.stringify({ version: 1, skills: skillUsage }, null, 2) + "\n");
	} catch {
		// Tracking must never prevent a skill from running.
	}
}

function truncate(value: string, width: number): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return visibleWidth(singleLine) <= width ? singleLine : `${singleLine.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
