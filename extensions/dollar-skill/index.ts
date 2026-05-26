import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const DOLLAR_SKILL_ANYWHERE =
	/(^|[ \t])\$([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?=$|[\s.,;:!?])/g;

type SkillCommand = ReturnType<ExtensionAPI["getCommands"]>[number] & {
	skillName: string;
};

function getSkillCommands(pi: ExtensionAPI): SkillCommand[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({
			...command,
			skillName: command.name.startsWith("skill:")
				? command.name.slice("skill:".length)
				: command.name,
		}));
}

function findDollarSkillNames(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(DOLLAR_SKILL_ANYWHERE)) {
		names.add(match[2]);
	}
	return [...names];
}

async function readSkillContent(command: SkillCommand): Promise<string> {
	let skillPath = command.sourceInfo.path;
	const info = await stat(skillPath);
	if (info.isDirectory()) {
		skillPath = path.join(skillPath, "SKILL.md");
	}
	return readFile(skillPath, "utf8");
}

async function expandInlineSkills(
	text: string,
	commands: SkillCommand[],
): Promise<string | undefined> {
	const names = findDollarSkillNames(text);
	if (names.length === 0) return undefined;

	const byName = new Map(
		commands.map((command) => [command.skillName, command]),
	);
	const matched = names
		.map((name) => byName.get(name))
		.filter((command): command is SkillCommand => Boolean(command));
	if (matched.length === 0) return undefined;

	const skillBlocks = await Promise.all(
		matched.map(async (command) => {
			const content = await readSkillContent(command);
			return `<skill name="${command.skillName}">\n${content}\n</skill>`;
		}),
	);

	return `${text}\n\nThe user invoked these skills with $skill syntax. Load and follow them as if invoked with /skill:name:\n\n${skillBlocks.join("\n\n")}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const match = beforeCursor.match(/(?:^|[ \t])\$([a-z0-9-]*)$/);

				if (!match) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const partial = match[1] ?? "";
				const commands = getSkillCommands(pi);
				const matches = partial
					? fuzzyFilter(
							commands,
							partial,
							(command) => `${command.skillName} ${command.description ?? ""}`,
						)
					: commands;
				const skills = matches.slice(0, 25).map((command) => ({
					value: `$${command.skillName}`,
					label: `$${command.skillName}`,
					description: command.description,
				}));

				if (skills.length === 0) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				return {
					prefix: `$${partial}`,
					items: skills,
				};
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(
					lines,
					cursorLine,
					cursorCol,
					item,
					prefix,
				);
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				if (beforeCursor.match(/(?:^|[ \t])\$([a-z0-9-]*)$/)) {
					return true;
				}
				return (
					current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
					true
				);
			},
		}));
	});

	pi.registerCommand("dollar-skills", {
		description: "Show how many $skill autocomplete entries are available",
		handler: async (_args, ctx) => {
			const skills = getSkillCommands(pi)
				.map((command) => command.skillName)
				.sort();
			ctx.ui.notify(
				`$skill extension sees ${skills.length} skills: ${skills.slice(0, 10).join(", ")}${skills.length > 10 ? ", ..." : ""}`,
				"info",
			);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const commands = getSkillCommands(pi);
		const requestedNames = findDollarSkillNames(event.text);
		const knownNames = new Set(commands.map((command) => command.skillName));
		const unknownNames = requestedNames.filter((name) => !knownNames.has(name));
		if (unknownNames.length > 0) {
			ctx.ui.notify(
				`No pi skill found for ${unknownNames.map((name) => `$${name}`).join(", ")}.`,
				"warning",
			);
		}

		const usedNames = requestedNames.filter((name) => knownNames.has(name));
		if (usedNames.length > 0) {
			ctx.ui.notify(
				`Using skill${usedNames.length === 1 ? "" : "s"} ${usedNames.map((name) => `$${name}`).join(", ")}.`,
				"info",
			);
		}

		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (!event.prompt.includes("$")) return;
		if (
			event.prompt.includes("The user invoked these skills with $skill syntax.")
		)
			return;

		const expanded = await expandInlineSkills(
			event.prompt,
			getSkillCommands(pi),
		);
		if (!expanded) return;

		const injected = expanded.slice(event.prompt.length).trimStart();
		if (!injected) return;

		return {
			message: {
				customType: "dollar-skill-inline",
				content: injected,
				display: false,
			},
		};
	});
}
