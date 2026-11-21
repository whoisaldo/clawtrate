// Light and dark follow the system: the palette is chosen from the system's
// appearance, which iOS reports to React Native and updates while the app runs.

import { createContext, useContext } from "react";
import { DARK, LIGHT, type Palette } from "./tokens.ts";

export { FONTS, SIZE_TOKENS as S, TOUCH } from "./tokens.ts";

export type Theme = { scheme: "light" | "dark"; c: Palette };

export function themeFor(scheme: string | null | undefined): Theme {
  return scheme === "dark" ? { scheme: "dark", c: DARK } : { scheme: "light", c: LIGHT };
}

export const ThemeContext = createContext<Theme>(themeFor("light"));

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * From the first accessibility text size (iOS scales text about 1.35 times and
 * more) a row puts its name or title on lines of its own, whole, and the time on
 * a line under it, instead of cutting the name to make room for the time.
 */
export const STACK_FROM_SCALE = 1.35;

export function stacked(fontScale: number): boolean {
  return fontScale >= STACK_FROM_SCALE;
}
