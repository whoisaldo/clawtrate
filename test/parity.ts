// The parity check: docs/parity.md against the checks that name its rows. A
// check names rows by starting its title, or the title of a group it is in,
// with their ids, for example `test("F-013 F-015: ...")`.
//
// A row is done on the platforms its platform cell names. A check under
// `apps/mobile/` (the iOS app's unit tests and its Simulator checks) is an iOS
// check; every other check is a desktop check. So a `both` row is `done` only
// when a desktop check and an iOS check both name it, an `iOS` row needs an iOS
// check, and `desktop done` and a `desktop` row need a desktop check.
//
// Only checks that will run count. The test runners themselves say which those
// are: Vitest collects each test file by running it, and Playwright loads each
// spec, so a check in a comment or behind code that never runs is never
// registered, and a skipped, fixme or todo check is listed as such and left out.
//
// A check can still skip itself from inside its body, which no listing shows.
// So a plain source rule comes on top: a test file that names a row in a title
// may not call `skip`, `fixme`, `todo` or `only` on its test or describe
// objects in any form. If a check cannot run somewhere, its row is not done.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const STATUSES = ["todo", "done", "desktop done", "gap"] as const;

export type ParityRow = { id: string; platform: string; status: string };

/** A check that will run, as the titles from its outermost group down to the test. */
export type CheckPath = string[];

/** The rows of the table: every line that starts with "| F-". */
export function parseTable(markdown: string): ParityRow[] {
  return markdown
    .split("\n")
    .filter((line) => /^\| F-\d{3} \|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      // A row starts and ends with a pipe, so the first and last cells are empty.
      return { id: cells[1]!, platform: cells[3]!, status: cells.at(-2)! };
    });
}

/** Whether a test file is one of the iOS app's checks. */
export function isIosCheck(file: string): boolean {
  return /(^|[\\/])apps[\\/]mobile[\\/]/.test(file);
}

/**
 * The checks in `vitest list --json --staticParse=false` output. Vitest leaves out skipped and todo
 * tests. `keep` chooses by test file, for the desktop's checks or the iOS app's.
 */
export function vitestChecks(
  json: string,
  keep: (file: string) => boolean = () => true,
): CheckPath[] {
  return (JSON.parse(json) as { name: string; file?: string }[])
    .filter((test) => keep(test.file ?? ""))
    .map((test) => test.name.split(" > "));
}

type PlaywrightSuite = {
  title: string;
  specs?: { title: string; tests: { expectedStatus: string }[] }[];
  suites?: PlaywrightSuite[];
};

/** The checks in `playwright test --list --reporter=json` output that are expected to pass. */
export function playwrightChecks(json: string): CheckPath[] {
  const checks: CheckPath[] = [];
  const walk = (suite: PlaywrightSuite, path: string[]) => {
    for (const spec of suite.specs ?? []) {
      if (spec.tests.some((test) => test.expectedStatus === "passed")) {
        checks.push([...path, spec.title]);
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
  };
  // The outermost suite is the file; its title is a path, not a check title.
  for (const file of (JSON.parse(json) as { suites: PlaywrightSuite[] }).suites) walk(file, []);
  return checks;
}

/** The ids at the start of each title in each check's path. */
export function checkIds(checks: CheckPath[]): string[] {
  const ids: string[] = [];
  for (const path of checks) {
    for (const title of path) {
      const lead = /^((?:F-\d{3}[ ,]*)+):/.exec(title);
      if (lead) ids.push(...lead[1]!.match(/F-\d{3}/g)!);
    }
  }
  return ids;
}

/** Run a runner's listing from `root`'s packages in `cwd`, outside the Vitest worker this is called from. */
function list(root: string, cwd: string, bin: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
  );
  return execFileSync(join(root, "node_modules/.bin", bin), args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The checks Vitest will run in `dir`, with the config found there; `keep` chooses by test file. */
export function listVitest(
  root: string,
  dir = root,
  keep: (file: string) => boolean = () => true,
): CheckPath[] {
  return vitestChecks(
    list(root, dir, "vitest", ["list", "--json", "--staticParse=false", "--root", dir]),
    keep,
  );
}

/** The checks Playwright will run for a config. */
export function listPlaywright(root: string, config: string): CheckPath[] {
  return playwrightChecks(
    list(root, root, "playwright", ["test", "--list", "--reporter=json", "-c", config]),
  );
}

/** A check title that starts with a row id. */
const PARITY_TITLE = /\b(?:test|it|describe)(?:\.\w+)*\(\s*[`'"](?:F-\d{3}[ ,]*)+:/;
/** `skip`, `fixme`, `todo` or `only` on a test or describe object, as a modifier or a call. */
const SKIPPING = /\b(?:test|it|describe)(?:\.\w+)*\.(?:skip|fixme|todo|only)\b/;

/** Every line of a test file that names a row and skips, or runs only some, of its checks. */
export function skipProblems(file: string, source: string): string[] {
  if (!PARITY_TITLE.test(source)) return [];
  return source.split("\n").flatMap((line, index) => {
    const found = SKIPPING.exec(line);
    return found
      ? [`${file}:${index + 1}: ${found[0]} in a file whose checks name parity rows`]
      : [];
  });
}

const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".run", "test-results", "baselines"]);

/**
 * Folders a build writes, which hold no test of ours: the iOS app's native
 * project (`expo prebuild`, with its Pods) and its build output. A build can be
 * writing them while the walk runs.
 */
const GENERATED = /(^|[\\/])apps[\\/]mobile[\\/](ios|android|build|\.expo)$/;

/** The test files under `dir`: every `*.test.ts` and `*.spec.ts`. */
export function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (GENERATED.test(path)) return [];
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && /\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Everything wrong with the table and the checks that name it: `desktop` are
 * the ids the desktop's checks name, `ios` those the iOS app's checks name.
 */
export function parityProblems(
  rows: ParityRow[],
  desktop: Set<string>,
  ios: Set<string> = new Set(),
): string[] {
  const problems: string[] = [];
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (!(STATUSES as readonly string[]).includes(row.status)) {
      problems.push(`${row.id}: unknown status "${row.status}"`);
    }
    if (row.status === "desktop done" && row.platform !== "both") {
      problems.push(`${row.id}: "desktop done" is only for rows whose platform is both`);
    }
    if (row.status !== "done" && row.status !== "desktop done") continue;
    if (!desktop.has(row.id) && !ios.has(row.id)) {
      problems.push(`${row.id}: marked ${row.status}, but no check that runs names it`);
      continue;
    }
    const needsDesktop = row.status === "desktop done" || row.platform !== "iOS";
    const needsIos = row.status === "done" && row.platform !== "desktop";
    if (needsDesktop && !desktop.has(row.id))
      problems.push(`${row.id}: marked ${row.status}, but no desktop check names it`);
    if (needsIos && !ios.has(row.id))
      problems.push(`${row.id}: marked ${row.status}, but no iOS check names it`);
  }
  for (const id of new Set([...desktop, ...ios]))
    if (!ids.has(id)) problems.push(`${id}: a check names it, but the table has no such row`);
  return problems;
}
