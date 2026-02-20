import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { OverlayItem, useVideoStore } from "../store/videoStore";

const OVERLAY_FOLDER = "sve-overlay-cache";

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const drawWrappedText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  maxWidth: number,
  lineHeight: number
) => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const testLine = current ? `${current} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = testLine;
    }
  }
  if (current) {
    lines.push(current);
  }
  if (lines.length === 0) {
    lines.push("");
  }
  const totalHeight = lineHeight * lines.length;
  lines.forEach((line, index) => {
    const y = centerY - totalHeight / 2 + lineHeight * index + lineHeight / 2;
    ctx.fillText(line, centerX, y, maxWidth);
  });
};

const loadImage = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = (error) => reject(error);
    image.src = src;
  });
};

async function ensureOverlayCacheDir() {
  const root = await appCacheDir();
  const dir = await join(root, OVERLAY_FOLDER);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export async function createOverlayCompositeFile(): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const state = useVideoStore.getState();
  if (!state.showScoreboardOverlay) {
    return null;
  }
  const visibleOverlays = state.overlays.filter((overlay) => overlay.visible);
  if (!visibleOverlays.length || state.videoWidth <= 0 || state.videoHeight <= 0) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = state.videoWidth;
  canvas.height = state.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sorted = [...visibleOverlays].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  for (const overlay of sorted) {
    if (overlay.type === "image" && overlay.imageSrc) {
      try {
        const image = await loadImage(overlay.imageSrc);
        ctx.drawImage(image, overlay.x, overlay.y, overlay.width, overlay.height);
      } catch (error) {
        console.warn("Failed to load overlay image", error);
      }
      continue;
    }
    const paddingX = 16;
    const paddingY = 12;
    roundRect(ctx, overlay.x, overlay.y, overlay.width, overlay.height, 12);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fill();
    if (!overlay.text) {
      continue;
    }
    ctx.font = `${overlay.fontSize ?? 24}px ${overlay.fontFamily ?? "Inter, sans-serif"}`;
    ctx.fillStyle = overlay.color ?? "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    drawWrappedText(
      ctx,
      overlay.text,
      overlay.x + overlay.width / 2,
      overlay.y + overlay.height / 2,
      Math.max(10, overlay.width - paddingX * 2),
      (overlay.fontSize ?? 24) * 1.1
    );
  }

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    return null;
  }
  const buffer = await blob.arrayBuffer();
  const dir = await ensureOverlayCacheDir();
  const fileName = `overlay-${Date.now()}.png`;
  const targetPath = await join(dir, fileName);
  await writeFile(targetPath, new Uint8Array(buffer));

  const cleanup = async () => {
    try {
      await remove(targetPath);
    } catch (error) {
      console.warn("Failed to remove overlay composite", error);
    }
  };

  return { path: targetPath, cleanup };
}