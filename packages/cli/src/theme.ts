import { resolveThemeTokens, type AppearanceScheme, type ThemeVariantConfig } from "../../../renderer/shared/appearance.ts";

interface Rgb {
	red: number;
	green: number;
	blue: number;
}

function hexToRgb(hex: string): Rgb {
	return {
		red: Number.parseInt(hex.slice(1, 3), 16),
		green: Number.parseInt(hex.slice(3, 5), 16),
		blue: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function channelHex(value: number): string {
	const clamped = Math.min(255, Math.max(0, Math.round(value)));
	return clamped.toString(16).padStart(2, "0");
}

/** Same blend as appearance.ts's private mixHex; kept local for opaque terminal surfaces. */
function mixHex(from: string, to: string, amount: number): string {
	const a = hexToRgb(from);
	const b = hexToRgb(to);
	const weight = Math.min(1, Math.max(0, amount));
	return `#${channelHex(a.red + (b.red - a.red) * weight)}${channelHex(a.green + (b.green - a.green) * weight)}${channelHex(a.blue + (b.blue - a.blue) * weight)}`.toUpperCase();
}

export function buildTheme(presetId: string, scheme: AppearanceScheme, variant: ThemeVariantConfig): Record<string, unknown> {
	const tokens = resolveThemeTokens(variant, scheme);
	const light = scheme === "light";
	const t = (name: string): string => tokens[name];
	const canvas = t("--theme-canvas");
	const raised = t("--theme-raised");
	const text = t("--text-primary");
	const accent = t("--accent");
	const secondary = t("--text-secondary");
	const tertiary = t("--text-tertiary");
	const quaternary = t("--text-quaternary");
	const green = t("--support-green");
	const red = t("--support-red");
	const warning = t("--support-warning");

	return {
		$schema:
			"https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		vars: {
			cyan: t("--terminal-cyan"),
			blue: t("--terminal-blue"),
			green,
			red,
			yellow: warning,
			text,
			gray: secondary,
			dimGray: tertiary,
			darkGray: quaternary,
			accent,
			selectedBg: mixHex(canvas, accent, light ? 0.12 : 0.18),
			userMsgBg: mixHex(canvas, text, 0.06),
			toolPendingBg: mixHex(canvas, text, 0.04),
			toolSuccessBg: mixHex(canvas, green, 0.1),
			toolErrorBg: mixHex(canvas, red, 0.1),
			customMsgBg: mixHex(canvas, accent, 0.08),
		},
		colors: {
			accent: "accent",
			border: "blue",
			borderAccent: "cyan",
			borderMuted: "darkGray",
			success: "green",
			error: "red",
			warning: "yellow",
			muted: "gray",
			dim: "dimGray",
			text: "text",
			thinkingText: "gray",

			selectedBg: "selectedBg",
			scrollbarTrack: "darkGray",
			scrollbarThumb: "text",
			searchMatchBg: "selectedBg",
			searchMatchText: "text",
			userMessageBg: "userMsgBg",
			userMessageText: "text",
			customMessageBg: "customMsgBg",
			customMessageText: "text",
			customMessageLabel: t("--syntax-title"),
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "text",
			toolOutput: "gray",

			mdHeading: t("--syntax-title"),
			mdLink: t("--terminal-blue"),
			mdLinkUrl: "dimGray",
			mdCode: "accent",
			mdCodeBlock: t("--syntax-string"),
			mdCodeBlockBorder: "dimGray",
			mdQuote: "gray",
			mdQuoteBorder: "dimGray",
			mdHr: "dimGray",
			mdListBullet: "accent",

			toolDiffAdded: "green",
			toolDiffRemoved: "red",
			toolDiffContext: "gray",

			syntaxComment: t("--syntax-comment"),
			syntaxKeyword: t("--syntax-keyword"),
			syntaxFunction: mixHex(accent, text, 0.5),
			syntaxVariable: t("--syntax-variable"),
			syntaxString: t("--syntax-string"),
			syntaxNumber: t("--syntax-number"),
			syntaxType: mixHex(t("--terminal-cyan"), text, 0.15),
			syntaxOperator: "text",
			syntaxPunctuation: "text",

			thinkingOff: quaternary,
			thinkingMinimal: tertiary,
			thinkingLow: secondary,
			thinkingMedium: mixHex(secondary, accent, 0.4),
			thinkingHigh: mixHex(secondary, accent, 0.7),
			thinkingXhigh: accent,
			thinkingMax: mixHex(accent, text, 0.35),

			bashMode: "green",
		},
		export: {
			pageBg: canvas,
			cardBg: raised,
			infoBg: mixHex(canvas, warning, 0.15),
		},
	};
}

