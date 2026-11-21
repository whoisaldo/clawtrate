// Derives every icon the apps use from the one logo file.
//
//   node tools/brand/src/make-icons.ts      (or: pnpm brand:icons)
//
// To change the logo, replace assets/brand/logo.png, run `pnpm brand:strip` to
// remove any provenance or text metadata, then run this command again.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, listChunks, METADATA_CHUNKS, resize, type Image } from "./png.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const LOGO_PATH = join(ROOT, "assets/brand/logo.png");
export const MANIFEST_PATH = join(ROOT, "assets/brand/generated.json");

const DESKTOP_DIR = join(ROOT, "apps/desktop/resources");
const WEB_DIR = join(ROOT, "apps/desktop/src/renderer/public");
const UI_DIR = join(ROOT, "packages/ui/src/assets");
const MOBILE_DIR = join(ROOT, "apps/mobile/assets");

/** Multiply alpha by a rounded-rectangle mask, with a one-pixel antialiased edge. */
function roundCorners(image: Image, radiusFraction: number): Image {
  const { width, height } = image;
  const radius = Math.min(width, height) * radiusFraction;
  const data = new Uint8Array(image.data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = Math.max(radius - px, px - (width - radius), 0);
      const dy = Math.max(radius - py, py - (height - radius), 0);
      const distance = Math.hypot(dx, dy) - radius;
      const coverage = Math.min(1, Math.max(0, 0.5 - distance));
      const i = (y * width + x) * 4 + 3;
      data[i] = Math.round(data[i]! * coverage);
    }
  }
  return { width, height, data };
}

/** Place an image centered on a transparent canvas. */
function pad(image: Image, size: number): Image {
  const data = new Uint8Array(size * size * 4);
  const ox = Math.floor((size - image.width) / 2);
  const oy = Math.floor((size - image.height) / 2);
  for (let y = 0; y < image.height; y += 1) {
    data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      ((y + oy) * size + ox) * 4,
    );
  }
  return { width: size, height: size, data };
}

/** Rounded-square tile used for favicons and Windows/Linux icons. */
function tile(logo: Image, size: number): Image {
  return roundCorners(resize(logo, size, size), 0.22);
}

/** macOS icon: the tile sits inside Apple's 824/1024 grid with a transparent margin. */
function macTile(logo: Image, size: number): Image {
  const body = Math.round((size * 824) / 1024);
  return pad(roundCorners(resize(logo, body, body), 0.225), size);
}

function ico(images: Image[]): Buffer {
  const pngs = images.map(encodePng);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = image.width >= 256 ? 0 : image.width;
    header[entry + 1] = image.height >= 256 ? 0 : image.height;
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(pngs[index]!.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += pngs[index]!.length;
  });
  return Buffer.concat([header, ...pngs]);
}

function icns(entries: Array<[type: string, image: Image]>): Buffer {
  const parts = entries.map(([type, image]) => {
    const png = encodePng(image);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Metadata chunks that must not be published with the logo. */
export function logoMetadataChunks(file: Uint8Array): string[] {
  return listChunks(file).filter((type) => (METADATA_CHUNKS as readonly string[]).includes(type));
}

function main(): void {
  const source = readFileSync(LOGO_PATH);
  const metadata = logoMetadataChunks(source);
  if (metadata.length > 0) {
    throw new Error(
      `assets/brand/logo.png carries ${metadata.join(", ")} metadata. Run \`pnpm brand:strip\` first.`,
    );
  }
  const logo = decodePng(source);
  if (logo.width !== logo.height) throw new Error("the logo must be square");

  const outputs: Record<string, Buffer> = {
    [join(DESKTOP_DIR, "icon.png")]: encodePng(tile(logo, 512)),
    [join(DESKTOP_DIR, "icon-mac.png")]: encodePng(macTile(logo, 1024)),
    [join(DESKTOP_DIR, "icon.ico")]: ico([16, 24, 32, 48, 64, 128, 256].map((s) => tile(logo, s))),
    [join(DESKTOP_DIR, "icon.icns")]: icns([
      ["icp4", macTile(logo, 16)],
      ["icp5", macTile(logo, 32)],
      ["icp6", macTile(logo, 64)],
      ["ic07", macTile(logo, 128)],
      ["ic08", macTile(logo, 256)],
      ["ic09", macTile(logo, 512)],
      ["ic10", macTile(logo, 1024)],
      ["ic11", macTile(logo, 32)],
      ["ic12", macTile(logo, 64)],
      ["ic13", macTile(logo, 256)],
      ["ic14", macTile(logo, 512)],
    ]),
    [join(WEB_DIR, "favicon.ico")]: ico([16, 32, 48].map((s) => tile(logo, s))),
    [join(WEB_DIR, "favicon-32.png")]: encodePng(tile(logo, 32)),
    [join(WEB_DIR, "apple-touch-icon.png")]: encodePng(resize(logo, 180, 180)),
    [join(UI_DIR, "logo-mark.png")]: encodePng(tile(logo, 128)),
    // iOS rounds an app's icon itself, so it is the whole square, 1024 points.
    [join(MOBILE_DIR, "icon.png")]: encodePng(resize(logo, 1024, 1024)),
    // The mark on the iOS connection screens: 56 points at 3x.
    [join(MOBILE_DIR, "logo-mark.png")]: encodePng(tile(logo, 168)),
  };

  for (const [path, bytes] of Object.entries(outputs)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const manifest = {
    source: relative(ROOT, LOGO_PATH),
    sourceSha256: sha256(LOGO_PATH),
    outputs: Object.keys(outputs)
      .map((path) => relative(ROOT, path))
      .sort(),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.outputs.length} icons from ${manifest.source}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
