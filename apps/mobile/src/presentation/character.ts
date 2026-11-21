// Bot characters as data, drawn for Clawtrate: a flat body in one colour and a
// dark visor with two eyes, on a 40-unit grid. The desktop's `Avatar.tsx` draws
// these shapes as SVG elements and the iOS app as react-native-svg ones, so a
// bot looks the same on every device. Pure: no DOM and no React.

/** One SVG shape, with its attributes as the element takes them. */
export type Shape =
  | { el: "circle"; cx: number; cy: number; r: number; transform?: string }
  | { el: "ellipse"; cx: number; cy: number; rx: number; ry: number; transform?: string }
  | {
      el: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      rx: number;
      transform?: string;
    }
  | {
      el: "path";
      d: string;
      strokeWidth?: number;
      strokeLinejoin?: "round";
      fill?: "none";
      stroke?: string;
      strokeLinecap?: "round";
    };

export const BODIES = {
  pebble: [{ el: "ellipse", cx: 20, cy: 20.5, rx: 17.5, ry: 15.5, transform: "rotate(-10 20 20)" }],
  block: [{ el: "rect", x: 3.5, y: 4.5, width: 33, height: 31, rx: 11 }],
  arch: [{ el: "path", d: "M5 19.5a15 15 0 0 1 30 0V30a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6V19.5Z" }],
  bloom: [
    { el: "circle", cx: 20, cy: 20, r: 11 },
    ...[0, 60, 120, 180, 240, 300].map((angle): Shape => ({
      el: "circle",
      cx: 20,
      cy: 9.6,
      r: 7.4,
      transform: `rotate(${angle} 20 20)`,
    })),
  ],
  disc: [{ el: "circle", cx: 20, cy: 20, r: 17 }],
  hex: [
    {
      el: "path",
      d: "M20 6.5 31.7 13.2v13.6L20 33.5 8.3 26.8V13.2L20 6.5Z",
      strokeWidth: 6,
      strokeLinejoin: "round",
    },
  ],
  drop: [
    {
      el: "path",
      d: "M20 3.5c8.8 0 15.5 6.2 15.5 14.6 0 9-7.2 15.3-15.5 18.4C11.7 33.4 4.5 27.1 4.5 18.1 4.5 9.7 11.2 3.5 20 3.5Z",
    },
  ],
  gem: [
    { el: "rect", x: 7.5, y: 7.5, width: 25, height: 25, rx: 8, transform: "rotate(45 20 20)" },
  ],
} satisfies Record<string, Shape[]>;

export type BodyName = keyof typeof BODIES;

const BODY_NAMES = Object.keys(BODIES) as BodyName[];

/** Every colour reads against the visor at 5.6:1 or better. */
export const CHARACTER_COLORS = [
  "#58c26f",
  "#5b8dff",
  "#ff8552",
  "#a98bff",
  "#f6bd3b",
  "#ff6f9c",
  "#45bdf5",
  "#a5d955",
] as const;

/** The visor's fill; the same in light and dark, since it sits on the body's colour. */
export const VISOR_COLOR = "#16181b";
/** The eyes' colour. */
export const EYE_COLOR = "#fff";

export type CharacterSpec = {
  body: BodyName;
  color: string;
  /** Degrees the visor leans. */
  tilt: number;
  /** Where the eyes look, in grid units. */
  look: [number, number];
  /** Moves the visor up (negative) or down. */
  lift?: number;
};

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) {
    h ^= char.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The character for a bot id. Stable across devices and restarts. */
export function characterFor(id: string): CharacterSpec {
  const angle = ((hash(`${id}:look`) % 8) / 8) * Math.PI * 2;
  return {
    body: BODY_NAMES[hash(`${id}:body`) % BODY_NAMES.length]!,
    color: CHARACTER_COLORS[hash(`${id}:colour`) % CHARACTER_COLORS.length]!,
    tilt: (hash(`${id}:tilt`) % 15) - 7,
    look: [Math.round(Math.cos(angle) * 8) / 10, Math.round(Math.sin(angle) * 5) / 10],
  };
}

/** The states a character's face can show (conversation.md, section 4). */
export type FaceState =
  "idle" | "thinking" | "working" | "waiting" | "blocked" | "done" | "failed" | "stopped";

/** The visor's centre line on the grid. */
export function visorY(spec: CharacterSpec): number {
  return 19.3 + (spec.lift ?? 0);
}

/** The visor: a pill 22.4 by 9.6 units around its centre line. */
export function visorOf(y: number): Extract<Shape, { el: "rect" }> {
  return { el: "rect", x: 8.8, y: y - 4.8, width: 22.4, height: 9.6, rx: 4.8 };
}

/**
 * The eyes say the state. Idle and stopped: looking the bot's own way.
 * Thinking: turned up. Working: straight ahead. Waiting: wide, on the viewer.
 * Blocked and failed: half closed. Done: smiling.
 */
export function eyesOf(state: FaceState, look: [number, number], y: number): Shape[] {
  let [lx, ly] = look;
  if (state === "thinking") [lx, ly] = [lx * 0.4, -1.7];
  if (state === "working" || state === "waiting" || state === "done") [lx, ly] = [0, 0];
  if (state === "blocked" || state === "failed") [lx, ly] = [0, 0.8];
  const eye = (x: number): Shape => {
    const cx = x + lx;
    const cy = y + ly;
    if (state === "waiting") return { el: "circle", cx, cy, r: 2.65 };
    if (state === "blocked" || state === "failed")
      return { el: "ellipse", cx, cy, rx: 2.2, ry: 0.85 };
    if (state === "done")
      return {
        el: "path",
        d: `M${cx - 2.1} ${cy + 0.9}Q${cx} ${cy - 2.6} ${cx + 2.1} ${cy + 0.9}`,
        fill: "none",
        stroke: EYE_COLOR,
        strokeWidth: 1.5,
        strokeLinecap: "round",
      };
    return { el: "circle", cx, cy, r: 2.05 };
  };
  return [eye(15.8), eye(24.2)];
}

/** How a face's state is spoken: "<Bot>, <state>". */
export const FACE_WORDS: Record<FaceState, string> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  waiting: "waiting for you",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/** The characters along the foot of the connection screens. Decoration only. */
export const ENSEMBLE: Array<CharacterSpec & { size: number; sink: number; lean: number }> = [
  {
    body: "drop",
    color: "#45bdf5",
    tilt: 3,
    look: [0.3, 0.5],
    lift: 1,
    size: 132,
    sink: -0.3,
    lean: -8,
  },
  {
    body: "arch",
    color: "#ff8552",
    tilt: 5,
    look: [-0.7, 0.3],
    lift: -1.5,
    size: 176,
    sink: -0.26,
    lean: 5,
  },
  { body: "disc", color: "#f6bd3b", tilt: 6, look: [0.8, 0], size: 118, sink: -0.2, lean: -4 },
  { body: "block", color: "#5b8dff", tilt: 0, look: [0.9, 0.2], size: 204, sink: -0.3, lean: 3 },
  {
    body: "pebble",
    color: "#58c26f",
    tilt: -7,
    look: [0.6, -0.3],
    size: 160,
    sink: -0.24,
    lean: -6,
  },
  { body: "hex", color: "#ff6f9c", tilt: -4, look: [-0.8, 0.2], size: 124, sink: -0.26, lean: 7 },
  { body: "bloom", color: "#a98bff", tilt: -5, look: [0, -0.5], size: 186, sink: -0.28, lean: -3 },
  { body: "gem", color: "#a5d955", tilt: 0, look: [-0.4, -0.4], size: 122, sink: -0.24, lean: 4 },
];

/** Below this height of the window the row of characters is not shown, so the form fits by itself. */
export const ENSEMBLE_MIN_HEIGHT = 640;

export function showEnsemble(height: number): boolean {
  return height >= ENSEMBLE_MIN_HEIGHT;
}
