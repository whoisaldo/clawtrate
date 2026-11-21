// The Computer tab's limits that the state's schema (`state-bounds.ts`) reads. This module
// imports nothing, so either file can be loaded first.

/** Viewers with a Computer tab at once; also the plugin's views per connection (8). */
export const MAX_COMPUTER_PANES = 8;
/** Tabs of one bot's browser kept for a pane; the rest are counted in `tabsOmitted`. */
export const MAX_COMPUTER_TABS = 16;
/** Latest control event per bot tab, newest kept. */
export const MAX_CONTROL_RECORDS = 32;
/** Runs a "Stop <Bot> in this task" names, at most. */
export const MAX_STOPPED_RUNS = 8;
/** Strings the pane keeps: titles, addresses, refusals. */
export const MAX_COMPUTER_TEXT = 1024;
