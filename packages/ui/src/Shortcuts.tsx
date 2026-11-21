import { useEffect, useRef } from "react";

/** Every keyboard shortcut the window has, written for the Mac (conversation.md, section 15). */
export const SHORTCUTS: Array<[keys: string, does: string]> = [
  ["↵", "Send, steer or hold, as the mode word says"],
  ["⇧↵", "New line"],
  ["⌥↵", "Queue after this turn"],
  ["⇧⌘↵", "Start as new task"],
  ["⌘↵", "Send from anywhere in the window"],
  ["⌘.", "Stop"],
  ["⌘J", "Go to what needs you"],
  ["⌘I", "Focus the message field"],
  ["⌘L", "Add the selected text to the message"],
  ["⌘F", "Find in this conversation"],
  ["⌘K", "Search bots, tasks, messages and more"],
  ["⇧⌘F", "Search bots in the sidebar"],
  ["⌘T", "New task for the open bot; ⌥T in a browser"],
  ["⌘1–9", "Open the bot in that place"],
  ["⌥↑ ⌥↓", "The bot above or below"],
  ["⌃Tab", "The next bot; ⇧⌃Tab, the one before"],
  ["⌘\\", "Show or hide the work panel"],
  ["⌘N", "New bot"],
  ["⌘,", "Settings"],
  ["⌘/", "Show these shortcuts"],
];

/**
 * The list of shortcuts, opened with ⌘/. It takes focus while open; Escape
 * or ⌘/ closes it and gives focus back to where it was.
 */
export function ShortcutList({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className="shortcuts"
      role="dialog"
      aria-label="Keyboard shortcuts"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
      }}
    >
      <p className="shortcuts-title">Keyboard shortcuts</p>
      <dl>
        {SHORTCUTS.map(([keys, does]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
      <p className="shortcuts-note">On Windows and Linux, Ctrl stands for ⌘ and Alt for ⌥.</p>
    </div>
  );
}
