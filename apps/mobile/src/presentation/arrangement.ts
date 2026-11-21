// The gateway's arrangement: pinned bots, the list, sections and hidden bots.

import type { Bot, SidebarPrefs, Task } from "@clawtrate/core";

export type SortOrder = "recent" | "name" | "manual";

export type RosterPrefs = {
  /** Pinned bots, in their own order. */
  pinned: string[];
  hidden: string[];
  sort: SortOrder;
  /** The manual order of the list. Bots not in it follow, in the gateway's order. */
  manual: string[];
  /** The user's sections, each a name and its bots; a bot is in at most one. */
  sections: Array<{ name: string; bots: string[] }>;
};

/** The gateway's arrangement, with this device's sort order. */
export function fromSidebar(prefs: SidebarPrefs, sort: SortOrder): RosterPrefs {
  return {
    pinned: prefs.pins,
    hidden: prefs.hidden,
    sort,
    manual: prefs.order,
    sections: prefs.sections,
  };
}

/** A bot's latest activity across its tasks, or null when it has none. */
export function latestActivity(tasks: Task[] | undefined): number | null {
  let latest: number | null = null;
  for (const task of tasks ?? []) {
    if (task.updatedAt !== null && (latest === null || task.updatedAt > latest)) {
      latest = task.updatedAt;
    }
  }
  return latest;
}

export type Arrangement = {
  pinned: Bot[];
  list: Bot[];
  /** The user's sections, after the list, each in the chosen order. */
  sections: Array<{ name: string; bots: Bot[] }>;
  hidden: Bot[];
};

/**
 * Pinned bots first, in their pinned order; then the list in the chosen order;
 * then each section; hidden bots apart. Ties keep the gateway's order, so the
 * order is stable.
 */
export function arrange(
  bots: Bot[],
  tasksByBot: Record<string, Task[]>,
  prefs: RosterPrefs,
): Arrangement {
  const hidden = new Set(prefs.hidden);
  const pinnedIds = prefs.pinned.filter((id) => !hidden.has(id));
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const pinned = pinnedIds.flatMap((id) => byId.get(id) ?? []);
  const rest = bots.filter((bot) => !hidden.has(bot.id) && !pinnedIds.includes(bot.id));
  const gateway = new Map(bots.map((bot, index) => [bot.id, index]));
  const position = (id: string) => {
    const index = prefs.manual.indexOf(id);
    return index === -1 ? prefs.manual.length + gateway.get(id)! : index;
  };
  const compare = {
    recent: (a: Bot, b: Bot) =>
      (latestActivity(tasksByBot[b.id]) ?? -Infinity) -
      (latestActivity(tasksByBot[a.id]) ?? -Infinity),
    name: (a: Bot, b: Bot) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    manual: (a: Bot, b: Bot) => position(a.id) - position(b.id),
  }[prefs.sort];
  const sorted = [...rest].sort((a, b) => compare(a, b) || gateway.get(a.id)! - gateway.get(b.id)!);
  const sectionOf = new Map<string, string>();
  for (const section of prefs.sections)
    for (const id of section.bots) if (!sectionOf.has(id)) sectionOf.set(id, section.name);
  const sections = prefs.sections
    .map((section) => ({
      name: section.name,
      bots: sorted.filter((bot) => sectionOf.get(bot.id) === section.name),
    }))
    .filter((section) => section.bots.length > 0);
  return {
    pinned,
    list: sorted.filter((bot) => !sectionOf.has(bot.id)),
    sections,
    hidden: bots.filter((bot) => hidden.has(bot.id)),
  };
}
