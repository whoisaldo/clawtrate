// The pairing code as a QR code in the terminal, two rows of modules per line of text.

import qrcode from "qrcode-generator";

/** Modules of light border around the code. */
const QUIET_ZONE = 2;

/** The code's modules: true is dark. */
export function qrModules(text: string): boolean[][] {
  const code = qrcode(0, "L");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = -QUIET_ZONE; row < size + QUIET_ZONE; row++) {
    const line: boolean[] = [];
    for (let col = -QUIET_ZONE; col < size + QUIET_ZONE; col++) {
      line.push(row >= 0 && col >= 0 && row < size && col < size && code.isDark(row, col));
    }
    rows.push(line);
  }
  return rows;
}

/**
 * The QR code as text. With `color`, dark modules are drawn black on a white background whatever
 * the terminal's theme; without it, the block characters are drawn in the terminal's own colour.
 */
export function renderQr(text: string, options: { color: boolean }): string {
  const rows = qrModules(text);
  const lines: string[] = [];
  for (let row = 0; row < rows.length; row += 2) {
    const top = rows[row]!;
    const bottom = rows[row + 1] ?? top.map(() => false);
    let line = "";
    for (let col = 0; col < top.length; col++) {
      const up = top[col]!;
      const down = bottom[col]!;
      line += up && down ? "█" : up ? "▀" : down ? "▄" : " ";
    }
    lines.push(options.color ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}
