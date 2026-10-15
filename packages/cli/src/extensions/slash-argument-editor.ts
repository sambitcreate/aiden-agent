/**
 * Slash autocomplete that waits for an argument, like the desktop composer and
 * opencode. pi's editor fills in "/name " on Enter and then submits at once, so
 * a command that needs text after it (/btw, /attach, a $ARGUMENTS template) runs
 * empty. This editor turns that Enter into Tab for those commands: the name is
 * filled in, the menu closes, and the next Enter sends "/name <argument>".
 * Commands that do not read an argument (pi's pickers, skills) still run on Enter.
 */

import { readFileSync } from "node:fs";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

/** Aiden commands whose handler only reports usage when nothing follows the name. */
export const AIDEN_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(["btw", "attach", "search"]);

const TEMPLATE_ARGUMENT = /\$(?:ARGUMENTS\b|@|\d|\{(?:\d|@))|^argument-hint:/mu;

/** A prompt template reads arguments when it declares a hint or uses pi's placeholders. */
export function templateTakesArgument(source: string): boolean {
	return TEMPLATE_ARGUMENT.test(source);
}

export function createArgumentCommandMatcher(
	commands: () => readonly SlashCommandInfo[],
	readTemplate: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): (name: string) => boolean {
	return (name) => {
		if (AIDEN_ARGUMENT_COMMANDS.has(name)) return true;
		const template = commands().find((command) => command.source === "prompt" && command.name === name);
		if (!template) return false;
		try {
			return templateTakesArgument(readTemplate(template.sourceInfo.path));
		} catch {
			return false;
		}
	};
}

const SLASH_NAME_DRAFT = /^\/\S*$/u;
const COMPLETED_SLASH_NAME = /^\/(\S+) $/u;

export class ArgumentAwareEditor extends CustomEditor {
	waitsForArgument: (name: string) => boolean = () => false;

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (
			this.isShowingAutocomplete() &&
			keys.matches(data, "tui.select.confirm") &&
			SLASH_NAME_DRAFT.test(this.getText()) &&
			keys.getKeys("tui.input.tab").includes("tab")
		) {
			// Tab fills in "/name " and closes the menu without submitting.
			super.handleInput("\t");
			const name = COMPLETED_SLASH_NAME.exec(this.getText())?.[1];
			if (name && this.waitsForArgument(name)) return;
			super.handleInput(data);
			return;
		}
		super.handleInput(data);
	}
}

export function createSlashArgumentEditorExtension(): { name: string; factory: ExtensionFactory } {
	return {
		name: "aiden-slash-arguments",
		factory: (pi) => {
			const waitsForArgument = createArgumentCommandMatcher(() => pi.getCommands());
			pi.on("session_start", async (_event, ctx) => {
				// Leave a user's own editor (vim mode and the like) in place.
				if (!ctx.hasUI || ctx.ui.getEditorComponent()) return;
				ctx.ui.setEditorComponent((tui, theme, keybindings) => {
					const editor = new ArgumentAwareEditor(tui, theme, keybindings, { embedWorkingStatus: true });
					editor.waitsForArgument = waitsForArgument;
					return editor;
				});
			});
		},
	};
}
