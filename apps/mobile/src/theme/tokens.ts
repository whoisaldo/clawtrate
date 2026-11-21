// The design's tokens for React Native (docs/design/visual-language.md, section
// 2). React Native does not read CSS, so the values are written here under the
// same names as `packages/ui/src/styles/tokens.css`; a unit test reads that file
// and fails when a value here differs from it. Sizes are the touch sizes of
// section 12 where the design gives one.

export const COLOR_TOKENS = [
  "bg",
  "bg-rail",
  "bg-raised",
  "bg-bubble",
  "bg-inset",
  "bg-code",
  "bg-hover",
  "bg-selected",
  "bg-inverse",
  "bg-scrim",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "text-faint",
  "text-inverse",
  "accent",
  "accent-soft",
  "accent-line",
  "accent-on",
  "bubble-user",
  "bubble-user-text",
  "warn",
  "warn-soft",
  "danger",
  "danger-soft",
  "danger-line",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type Palette = Record<ColorToken, string>;

export const LIGHT: Palette = {
  bg: "#ffffff",
  "bg-rail": "#f6f6f5",
  "bg-raised": "#ffffff",
  "bg-bubble": "#f0f0ee",
  "bg-inset": "#f0f0ee",
  "bg-code": "rgba(17, 18, 19, 0.06)",
  "bg-hover": "rgba(17, 18, 19, 0.05)",
  "bg-selected": "rgba(17, 18, 19, 0.08)",
  "bg-inverse": "#111213",
  "bg-scrim": "rgba(17, 18, 19, 0.22)",
  border: "rgba(17, 18, 19, 0.09)",
  "border-strong": "rgba(17, 18, 19, 0.16)",
  text: "#111213",
  "text-muted": "#55575b",
  "text-faint": "#606266",
  "text-inverse": "#ffffff",
  accent: "#0a6e5c",
  "accent-soft": "rgba(10, 110, 92, 0.1)",
  "accent-line": "#0d8f77",
  "accent-on": "#ffffff",
  "bubble-user": "#0a6e5c",
  "bubble-user-text": "#ffffff",
  warn: "#935600",
  "warn-soft": "rgba(147, 86, 0, 0.1)",
  danger: "#b3261e",
  "danger-soft": "rgba(179, 38, 30, 0.09)",
  "danger-line": "rgba(179, 38, 30, 0.3)",
};

export const DARK: Palette = {
  bg: "#101112",
  "bg-rail": "#0b0c0d",
  "bg-raised": "#1c1d1f",
  "bg-bubble": "#1f2022",
  "bg-inset": "#1a1b1d",
  "bg-code": "rgba(255, 255, 255, 0.08)",
  "bg-hover": "rgba(255, 255, 255, 0.06)",
  "bg-selected": "rgba(255, 255, 255, 0.1)",
  "bg-inverse": "#f3f3f2",
  "bg-scrim": "rgba(0, 0, 0, 0.5)",
  border: "rgba(255, 255, 255, 0.08)",
  "border-strong": "rgba(255, 255, 255, 0.16)",
  text: "#f3f3f2",
  "text-muted": "#b4b6b9",
  "text-faint": "#9d9fa2",
  "text-inverse": "#111213",
  accent: "#3ee6c1",
  "accent-soft": "rgba(62, 230, 193, 0.12)",
  "accent-line": "#3ee6c1",
  "accent-on": "#04261f",
  "bubble-user": "#3ee6c1",
  "bubble-user-text": "#04261f",
  warn: "#f0b45a",
  "warn-soft": "rgba(240, 180, 90, 0.12)",
  danger: "#ff8a80",
  "danger-soft": "rgba(255, 138, 128, 0.12)",
  "danger-line": "rgba(255, 138, 128, 0.42)",
};

/** Sizes, in points, from the same file. */
export const SIZE_TOKENS = {
  "text-xs": 12,
  "text-sm": 13,
  "text-md": 14,
  "text-base": 15,
  "text-lg": 17,
  "text-title": 28,
  "space-1": 4,
  "space-2": 8,
  "space-3": 12,
  "space-4": 16,
  "space-5": 20,
  "space-6": 24,
  "space-8": 32,
  "space-10": 40,
  "radius-sm": 10,
  "radius-md": 14,
  "radius-lg": 18,
  "tap-min": 44,
  "avatar-pin": 56,
  "avatar-hero": 64,
  "avatar-pill": 22,
} as const;

export type SizeToken = keyof typeof SIZE_TOKENS;

/** The phone's own sizes (section 12): rows and avatars at touch size, text one step larger. */
export const TOUCH = {
  /** A bot row. */
  row: 68,
  /** A bot row's avatar. */
  avatarRow: 44,
  /** A task row. */
  taskRow: 44,
  /** Names and message text. */
  bodyText: 17,
  /** Round buttons. */
  roundButton: 40,
  /** The connection screens' buttons and fields (section 4, `data-size="lg"`). */
  large: 48,
  /** The connection screens' column. */
  column: 360,
} as const;

/** The two faces, as iOS names the embedded fonts. */
export const FONTS = {
  regular: "Figtree-Regular",
  medium: "Figtree-Medium",
  strong: "Figtree-SemiBold",
  /** Emphasis inside a reply only: interface text is never italic. */
  italic: "Figtree-Italic",
  mono: "JetBrainsMono-Regular",
} as const;
