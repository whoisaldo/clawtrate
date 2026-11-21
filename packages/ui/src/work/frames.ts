// The live picture of a view (work-pane.md, section 17). Frames are asked of
// the host one at a time (`computerFrame`), decoded, drawn on every canvas the
// view is shown on, and dropped: none is written to a cache, a log or storage,
// and when the view ends the canvases are cleared and the decoded picture is
// closed. A frame for a view that has ended is dropped before it is decoded.

import {
  computerWords as words,
  type ClawtrateBridge,
  type ComputerView,
  type pictureAge,
} from "@clawtrate/core";
import { useEffect, useMemo, useRef, useState } from "react";

export type FrameCanvases = {
  /** Show the view on this canvas; the returned function stops it. */
  attach(canvas: HTMLCanvasElement): () => void;
};

/** The newest frame drawn for view `n`: when, on this device's clock, and when it was captured. */
export type Drawn = { n: number; at: number; capturedAt: number | null };

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The page size (CSS pixels) of the frame a canvas shows, as its frame's header gave it: a click is
 * mapped with the picture on screen, not with a newer frame not yet drawn (`pagePoint`).
 */
export type PageSize = { width: number; height: number };
export function drawnPage(canvas: HTMLCanvasElement): PageSize | null {
  const width = Number(canvas.dataset.pageWidth);
  const height = Number(canvas.dataset.pageHeight);
  return width > 0 && height > 0 ? { width, height } : null;
}

function draw(canvas: HTMLCanvasElement, picture: ImageBitmap | null, page: PageSize | null): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  if (!picture || !page) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    delete canvas.dataset.pageWidth;
    delete canvas.dataset.pageHeight;
    return;
  }
  canvas.dataset.pageWidth = String(page.width);
  canvas.dataset.pageHeight = String(page.height);
  if (canvas.width !== picture.width || canvas.height !== picture.height) {
    canvas.width = picture.width;
    canvas.height = picture.height;
  }
  context.drawImage(picture, 0, 0);
}

/** Pull and draw one view's frames while it is connecting or live. */
export function useFrames(
  bridge: ClawtrateBridge,
  view: ComputerView | null,
): { canvases: FrameCanvases; drawn: Drawn | null } {
  const canvases = useRef(new Set<HTMLCanvasElement>());
  // Only a frame that was decoded and drawn counts: one too large or undecodable is none.
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const picture = useRef<ImageBitmap | null>(null);
  const page = useRef<PageSize | null>(null);
  const n = view && view.status !== "ended" ? view.n : null;

  useEffect(() => {
    if (n === null) return;
    const shown = canvases.current;
    let stopped = false;
    let after = 0;
    void (async () => {
      while (!stopped) {
        let frame;
        try {
          frame = await bridge.invoke({ type: "computerFrame", n, after });
        } catch {
          // The host is busy or the view went: look again shortly while it lasts.
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (stopped) return;
        if (!frame || frame.n !== n) continue;
        after = frame.seq;
        let decoded: ImageBitmap;
        try {
          decoded = await createImageBitmap(new Blob([decode(frame.jpeg)], { type: "image/jpeg" }));
        } catch {
          continue;
        }
        if (stopped) {
          decoded.close();
          return;
        }
        picture.current?.close();
        picture.current = decoded;
        page.current = { width: frame.width, height: frame.height };
        for (const canvas of shown) draw(canvas, decoded, page.current);
        setDrawn({ n, at: Date.now(), capturedAt: frame.capturedAt });
      }
    })();
    return () => {
      stopped = true;
      // Nothing of the picture remains.
      picture.current?.close();
      picture.current = null;
      page.current = null;
      for (const canvas of shown) draw(canvas, null, null);
    };
  }, [bridge, n]);

  const attach = useMemo<FrameCanvases>(
    () => ({
      attach(canvas) {
        canvases.current.add(canvas);
        draw(canvas, picture.current, page.current);
        return () => {
          canvases.current.delete(canvas);
        };
      },
    }),
    [],
  );
  return { canvases: attach, drawn: drawn && drawn.n === n ? drawn : null };
}

/** This device's clock, read again every second while `active`, so an age changes by itself. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export type Picture = ReturnType<typeof pictureAge>;

/** What the badge on a live view says of its picture. */
export const pictureWords = (picture: Picture) =>
  picture.kind === "live"
    ? "Live"
    : picture.kind === "last"
      ? words.lastPictureLine(picture.ageMs)
      : words.noPictureLine;
