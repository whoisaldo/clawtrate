// The phone's "Type into the page" field (work-pane.md, section 18, On the phone). Each part of
// the text goes to the host as one input call, in the order it was typed, one call at a time.
// The field shows only what the host accepted or has on its way; text it refused (its queue was
// full) is held apart, shown as not sent, and goes again only when the person asks, before
// anything typed after it. Nothing accepted is sent twice. Accepted is not delivered: the page
// shows what arrived.

/** One input call's text at most (`MAX_INPUT_TEXT`), in UTF-16 units. */
const CALL_CHARS = 2000;

/** At most `max` units of `text`, never half a character: a cut inside a surrogate pair moves before it. */
export function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `text` as input calls, in order, each whole characters within one call's limit; at most `calls`. */
export function callParts(text: string, calls: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest && out.length < calls) {
    const part = cutWhole(rest, CALL_CHARS);
    out.push(part);
    rest = rest.slice(part.length);
  }
  return out;
}

export type Typing = {
  /** Accepted by the host, in order. */
  accepted: string;
  /** Handed to the host, its answer not back yet. */
  flight: string;
  /** Typed and not accepted: waiting its turn, or refused and held. */
  unsent: string;
  /** A refusal holds what wasn't accepted until the person sends it again. */
  held: boolean;
  /** Each opening of the field is a session: a call's answer counts only in its own. */
  session: number;
};

export const emptyTyping: Typing = {
  accepted: "",
  flight: "",
  unsent: "",
  held: false,
  session: 0,
};

/** The field closed or opened again: a new session, empty; a call still out belongs to the old one. */
export const restart = (t: Typing): Typing => ({ ...emptyTyping, session: t.session + 1 });

/** What the field shows. */
export const fieldText = (t: Typing) => t.accepted + t.flight;

/**
 * The field now reads `value`: anything after what it showed (`shown`; for an input method, the
 * field when composing started) is typed, and waits its turn.
 */
export function typedInto(t: Typing, value: string, shown = fieldText(t)): Typing {
  // Only text can be sent: a deletion or a replacement of what went is not taken back.
  if (!value.startsWith(shown) || value.length === shown.length) return t;
  // One edit (a paste) is at most one call's text: what can't go in one isn't kept either.
  return { ...t, unsent: t.unsent + cutWhole(value.slice(shown.length), CALL_CHARS) };
}

/** The next call to make, if any: the oldest text not accepted, one call's worth, never two at once. */
export function nextCall(t: Typing): { typing: Typing; text: string; session: number } | null {
  if (t.flight || t.held || !t.unsent) return null;
  const text = cutWhole(t.unsent, CALL_CHARS);
  return {
    typing: { ...t, flight: text, unsent: t.unsent.slice(text.length) },
    text,
    session: t.session,
  };
}

/**
 * The host answered the call on its way: accepted, or refused and held, ahead of what followed.
 * An answer for a call of an earlier session changes nothing.
 */
export function answered(t: Typing, accepted: boolean, session: number): Typing {
  if (session !== t.session) return t;
  return accepted
    ? { ...t, accepted: t.accepted + t.flight, flight: "" }
    : { ...t, flight: "", unsent: t.flight + t.unsent, held: true };
}

/** The person sends what was held again. */
export const sendAgain = (t: Typing): Typing => ({ ...t, held: false });
