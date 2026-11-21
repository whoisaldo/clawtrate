// The Work pane's tab bar (bots.md, section 19; work-pane.md, section 1). Tabs
// never wrap or shorten their word. When they do not fit, each tab's side
// padding narrows from 14 to 10 px first; if they still do not fit, the row
// scrolls sideways with no scroll bar, a 16 px fade at each edge that is
// actually clipped, and the chosen tab kept in view.

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

export type TabSpec<T extends string> = {
  id: T;
  label: string;
  /** A 6 px mark after the word (the Computer tab while the bot's browser is in use), and its name. */
  mark?: string | null;
};

type Fit = "normal" | "narrow" | "scroll";

/** Scroll the row so `tab` is wholly in view, by the least distance. */
function keepInView(bar: HTMLElement, tab: HTMLElement): void {
  // The row's own side padding comes into view with its first and last tab.
  const style = getComputedStyle(bar);
  const left = tab.offsetLeft - bar.offsetLeft - parseFloat(style.paddingLeft);
  const right = tab.offsetLeft - bar.offsetLeft + tab.offsetWidth + parseFloat(style.paddingRight);
  if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left);
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
}

/** Which edges of the row hide part of a tab right now. */
function markClipped(bar: HTMLElement): void {
  const start = bar.scrollLeft > 0.5;
  const end = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 0.5;
  const clip = start && end ? "both" : start ? "start" : end ? "end" : null;
  if (clip) bar.dataset.clip = clip;
  else delete bar.dataset.clip;
}

export function TabBar<T extends string>({
  tabs,
  selected,
  onSelect,
  idPrefix,
  label,
}: {
  tabs: readonly TabSpec<T>[];
  selected: T;
  onSelect: (id: T) => void;
  idPrefix: string;
  label: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  // Decide the fit from the row's own measurements, whenever its width or the
  // words change: normal padding, then narrow, then scrolling.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const fit = () => {
      let next: Fit = "normal";
      bar.dataset.fit = next;
      if (bar.scrollWidth > bar.clientWidth + 0.5) {
        next = "narrow";
        bar.dataset.fit = next;
      }
      if (bar.scrollWidth > bar.clientWidth + 0.5) {
        next = "scroll";
        bar.dataset.fit = next;
      }
      const chosen = bar.querySelector<HTMLElement>('[aria-selected="true"]');
      if (next === "scroll" && chosen) keepInView(bar, chosen);
      if (next !== "scroll") bar.scrollLeft = 0;
      markClipped(bar);
    };
    fit();
    // The row's width, and each tab's: a larger text size changes the tabs, not the row.
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    for (const tab of bar.querySelectorAll(".tab")) observer.observe(tab);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [tabs]);

  // The chosen tab is kept in view whenever it changes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const chosen = bar?.querySelector<HTMLElement>(`#${idPrefix}-${selected}`);
    if (bar && chosen && bar.dataset.fit === "scroll") keepInView(bar, chosen);
    if (bar) markClipped(bar);
  }, [selected, idPrefix]);

  // One tab stop; Left and Right move and select, wrapping; Home and End go to the ends.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === selected);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    event.currentTarget
      .querySelector<HTMLElement>(`#${idPrefix}-${id}`)
      ?.focus({ preventScroll: true });
  };

  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      ref={barRef}
      onScroll={(event) => markClipped(event.currentTarget)}
      data-testid="work-tabs"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="tab"
          role="tab"
          id={`${idPrefix}-${tab.id}`}
          aria-controls={`${idPrefix}panel-${tab.id}`}
          aria-selected={selected === tab.id}
          aria-label={tab.mark ?? undefined}
          tabIndex={selected === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.mark && <span className="tab-mark" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
