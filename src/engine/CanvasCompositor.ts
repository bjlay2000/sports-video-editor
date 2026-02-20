import type { ComputedOverlay, RenderFrameState } from "./types";

/* ---- image cache ---- */

const imageCache = new Map<string, HTMLImageElement>();

function loadImageCached(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached && cached.complete) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

/* ---- drawing helpers ---- */

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push("");

  const totalH = lineHeight * lines.length;
  lines.forEach((l, i) => {
    const y = cy - totalH / 2 + lineHeight * i + lineHeight / 2;
    ctx.fillText(l, cx, y, maxWidth);
  });
}

/* ---- constants ---- */

const ACCENT_ALPHA = "rgba(233, 69, 96, 0.8)";
const RING_UNSELECTED = "rgba(0, 0, 0, 0.3)";

/* ---- single overlay ---- */

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: ComputedOverlay,
  img: HTMLImageElement | undefined,
  selected: boolean,
) {
  ctx.save();
  ctx.globalAlpha = overlay.opacity;

  if (overlay.rotation) {
    const cx = overlay.x + overlay.width / 2;
    const cy = overlay.y + overlay.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((overlay.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // Shadow
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 15;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  if (overlay.type === "image" && img) {
    ctx.drawImage(img, overlay.x, overlay.y, overlay.width, overlay.height);
  } else {
    // Background
    roundRect(ctx, overlay.x, overlay.y, overlay.width, overlay.height, 12);
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fill();

    // Text (drawn without shadow)
    ctx.shadowColor = "transparent";
    if (overlay.text) {
      ctx.font = `${overlay.fontSize ?? 24}px ${overlay.fontFamily ?? "Inter, sans-serif"}`;
      ctx.fillStyle = overlay.color ?? "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const padX = 12;
      drawWrappedText(
        ctx,
        overlay.text,
        overlay.x + overlay.width / 2,
        overlay.y + overlay.height / 2,
        Math.max(10, overlay.width - padX * 2),
        (overlay.fontSize ?? 24) * 1.1,
      );
    }
  }

  ctx.restore();

  // Ring (drawn without shadow)
  ctx.save();
  ctx.globalAlpha = overlay.opacity;
  if (overlay.rotation) {
    const cx = overlay.x + overlay.width / 2;
    const cy = overlay.y + overlay.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((overlay.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  roundRect(ctx, overlay.x, overlay.y, overlay.width, overlay.height, 12);
  if (selected) {
    ctx.strokeStyle = ACCENT_ALPHA;
    ctx.lineWidth = 2;
  } else {
    ctx.strokeStyle = RING_UNSELECTED;
    ctx.lineWidth = 1;
  }
  ctx.stroke();
  ctx.restore();
}

/* ---- public API ---- */

/**
 * Render all overlays for export (no selection chrome).
 */
export async function renderFrame(
  ctx: CanvasRenderingContext2D,
  state: RenderFrameState,
  width: number,
  height: number,
): Promise<void> {
  ctx.clearRect(0, 0, width, height);

  for (const overlay of state.overlays) {
    let img: HTMLImageElement | undefined;
    if (overlay.type === "image" && overlay.imageSrc) {
      try {
        img = await loadImageCached(overlay.imageSrc);
      } catch {
        /* skip */
      }
    }
    drawOverlay(ctx, overlay, img, false);
  }
}

/**
 * Render overlays synchronously for live preview, including selection chrome.
 */
export function renderFrameSync(
  ctx: CanvasRenderingContext2D,
  state: RenderFrameState,
  width: number,
  height: number,
  selectedIds?: Set<string>,
): void {
  ctx.clearRect(0, 0, width, height);

  for (const overlay of state.overlays) {
    let img: HTMLImageElement | undefined;
    if (overlay.type === "image" && overlay.imageSrc) {
      const cached = imageCache.get(overlay.imageSrc);
      if (cached && cached.complete) img = cached;
    }
    const selected = selectedIds?.has(overlay.id) ?? false;
    drawOverlay(ctx, overlay, img, selected);
  }
}

/**
 * Pre-load all image assets for synchronous rendering.
 */
export async function preloadImages(
  overlays: ComputedOverlay[],
): Promise<void> {
  const sources = overlays
    .filter((o) => o.type === "image" && o.imageSrc)
    .map((o) => o.imageSrc!)
    .filter(
      (src) => !imageCache.has(src) || !imageCache.get(src)!.complete,
    );

  await Promise.all(
    sources.map((src) => loadImageCached(src).catch(() => {})),
  );
}

export { loadImageCached, roundRect, drawWrappedText };
