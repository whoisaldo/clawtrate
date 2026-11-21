// The packaged app carries no node_modules (packaging/config.ts), and the
// update check builds the app into a temporary folder that reaches none, so the
// desktop main process may require no package at run time: every package it
// imports, through every module it reaches, is one the build bundles
// (electron.vite.config.ts), Electron's own, or Node's.

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../electron.vite.config.ts";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every package a module and its relative imports bring in, type-only imports aside. */
function packagesOf(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm,
    )) {
      const specifier = (match[1] ?? match[2] ?? match[3])!;
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      else found.set(specifier, file);
    }
  };
  visit(entry);
  return found;
}

/** A specifier's package: `@scope/name` or `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("the desktop main bundle", () => {
  it("requires no package at run time: each one it imports is bundled, Electron's or Node's", () => {
    const build = (config as { main?: { build?: { externalizeDeps?: { exclude?: string[] } } } })
      .main?.build?.externalizeDeps?.exclude;
    const bundled = new Set(build ?? []);
    const packages = packagesOf(resolve(DESKTOP, "src/main/index.ts"));
    const required = [...packages].filter(([specifier]) => {
      const name = packageName(specifier);
      return (
        !bundled.has(name) &&
        name !== "electron" &&
        !specifier.startsWith("node:") &&
        !builtinModules.includes(name)
      );
    });
    expect(required).toEqual([]);
    // The walk reaches the setup's synthetic gateway, the one module that needs `ws`.
    expect(packages.get("ws")).toMatch(/synthetic-gateway\.ts$/);
    expect(bundled.has("ws")).toBe(true);
  });
});
