/// <reference lib="webworker" />

import { getRenderState } from "./RenderEngine";
import type { ComputedOverlay, TimelineModel } from "./types";

type InitMessage = {
  type: "init";
  width: number;
  height: number;
  timelineModel: TimelineModel;
};

type StartMessage = {
  type: "start";
  totalFrames: number;
  fps: number;
};

type RecycleMessage = {
  type: "recycle";
  buffer: ArrayBuffer;
};

type WorkerInMessage = InitMessage | StartMessage | RecycleMessage;

type FrameMessage = {
  type: "frame";
  frameIndex: number;
  buffer: ArrayBuffer;
};

type WorkerOutMessage =
  | { type: "ready" }
  | FrameMessage
  | { type: "done" }
  | { type: "error"; message: string };

const imageBitmapCache = new Map<string, ImageBitmap>();

let timelineModel: TimelineModel | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let renderWidth = 0;
let renderHeight = 0;
const FRAME_BUFFER_POOL_SIZE = 3;
let frameBufferByteLength = 0;
let availableFrameBuffers: ArrayBuffer[] = [];
const frameBufferWaiters: Array<(buffer: ArrayBuffer) => void> = [];

function roundRect(
  target: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  target.beginPath();
  target.moveTo(x + radius, y);
  target.lineTo(x + w - radius, y);
  target.quadraticCurveTo(x + w, y, x + w, y + radius);
  target.lineTo(x + w, y + h - radius);
  target.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  target.lineTo(x + radius, y + h);
  target.quadraticCurveTo(x, y + h, x, y + h - radius);
  target.lineTo(x, y + radius);
  target.quadraticCurveTo(x, y, x + radius, y);
  target.closePath();
}

function drawWrappedText(
  target: OffscreenCanvasRenderingContext2D,
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
    if (target.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push("");

  const totalH = lineHeight * lines.length;
  lines.forEach((value, index) => {
    const y = cy - totalH / 2 + lineHeight * index + lineHeight / 2;
    target.fillText(value, cx, y, maxWidth);
  });
}

function drawOverlay(
  target: OffscreenCanvasRenderingContext2D,
  overlay: ComputedOverlay,
  image: ImageBitmap | undefined,
) {
  target.save();
  target.globalAlpha = overlay.opacity;

  if (overlay.rotation) {
    const cx = overlay.x + overlay.width / 2;
    const cy = overlay.y + overlay.height / 2;
    target.translate(cx, cy);
    target.rotate((overlay.rotation * Math.PI) / 180);
    target.translate(-cx, -cy);
  }

  target.shadowColor = "rgba(0, 0, 0, 0.4)";
  target.shadowBlur = 15;
  target.shadowOffsetX = 0;
  target.shadowOffsetY = 4;

  if (overlay.type === "image" && image) {
    target.drawImage(image, overlay.x, overlay.y, overlay.width, overlay.height);
  } else {
    roundRect(target, overlay.x, overlay.y, overlay.width, overlay.height, 12);
    target.fillStyle = "rgba(0, 0, 0, 0.6)";
    target.fill();

    target.shadowColor = "transparent";
    if (overlay.text) {
      target.font = `${overlay.fontSize ?? 24}px ${overlay.fontFamily ?? "Inter, sans-serif"}`;
      target.fillStyle = overlay.color ?? "#ffffff";
      target.textAlign = "center";
      target.textBaseline = "middle";
      drawWrappedText(
        target,
        overlay.text,
        overlay.x + overlay.width / 2,
        overlay.y + overlay.height / 2,
        Math.max(10, overlay.width - 24),
        (overlay.fontSize ?? 24) * 1.1,
      );
    }
  }

  target.restore();

  target.save();
  target.globalAlpha = overlay.opacity;
  if (overlay.rotation) {
    const cx = overlay.x + overlay.width / 2;
    const cy = overlay.y + overlay.height / 2;
    target.translate(cx, cy);
    target.rotate((overlay.rotation * Math.PI) / 180);
    target.translate(-cx, -cy);
  }
  roundRect(target, overlay.x, overlay.y, overlay.width, overlay.height, 12);
  target.strokeStyle = "rgba(0, 0, 0, 0.3)";
  target.lineWidth = 1;
  target.stroke();
  target.restore();
}

async function preloadImages(overlays: TimelineModel["overlays"]) {
  const imageSources = [...new Set(
    overlays
      .filter((overlay) => overlay.type === "image" && overlay.imageSrc)
      .map((overlay) => overlay.imageSrc as string),
  )];

  await Promise.all(
    imageSources.map(async (src) => {
      if (imageBitmapCache.has(src)) {
        return;
      }
      try {
        const response = await fetch(src);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        imageBitmapCache.set(src, bitmap);
      } catch {
        // ignore failed image assets
      }
    }),
  );
}

function postMessageTyped(message: WorkerOutMessage, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

function resetFrameBufferPool() {
  frameBufferByteLength = renderWidth * renderHeight * 4;
  availableFrameBuffers = [];
  frameBufferWaiters.length = 0;

  for (let i = 0; i < FRAME_BUFFER_POOL_SIZE; i++) {
    availableFrameBuffers.push(new ArrayBuffer(frameBufferByteLength));
  }
}

function recycleFrameBuffer(buffer: ArrayBuffer) {
  if (buffer.byteLength !== frameBufferByteLength) {
    return;
  }

  const waiter = frameBufferWaiters.shift();
  if (waiter) {
    waiter(buffer);
    return;
  }

  availableFrameBuffers.push(buffer);
}

function acquireFrameBuffer(): Promise<ArrayBuffer> {
  const nextBuffer = availableFrameBuffers.pop();
  if (nextBuffer) {
    return Promise.resolve(nextBuffer);
  }
  return new Promise((resolve) => {
    frameBufferWaiters.push(resolve);
  });
}

async function handleStart(totalFrames: number, fps: number) {
  if (!timelineModel || !ctx || !canvas) {
    throw new Error("Worker not initialized");
  }

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    const time = frameIndex / fps;
    const state = getRenderState(timelineModel, time);

    ctx.clearRect(0, 0, renderWidth, renderHeight);
    for (const overlay of state.overlays) {
      const bitmap = overlay.imageSrc ? imageBitmapCache.get(overlay.imageSrc) : undefined;
      drawOverlay(ctx, overlay, bitmap);
    }

    const frameBuffer = await acquireFrameBuffer();
    const frameImageData = new Uint8ClampedArray(frameBuffer);
    const t0 = performance.now();
    // const imageData = ctx.getImageData(0, 0, renderWidth, renderHeight);
    const t1 = performance.now();
    console.log("getImageData ms:", (t1 - t0).toFixed(2));

    // frameImageData.set(imageData.data);
    frameImageData.fill(0);


    postMessageTyped(
      {
        type: "frame",
        frameIndex,
        buffer: frameBuffer,
      },
      [frameBuffer],
    );
  }
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  try {
    if (event.data.type === "init") {
      renderWidth = Math.max(1, Math.floor(event.data.width));
      renderHeight = Math.max(1, Math.floor(event.data.height));
      timelineModel = event.data.timelineModel;

      canvas = new OffscreenCanvas(renderWidth, renderHeight);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error("Cannot create OffscreenCanvas context");
      }

      resetFrameBufferPool();

      await preloadImages(timelineModel.overlays);
      postMessageTyped({ type: "ready" });
      return;
    }

    if (event.data.type === "recycle") {
      recycleFrameBuffer(event.data.buffer);
      return;
    }

    if (event.data.type === "start") {
      await handleStart(event.data.totalFrames, event.data.fps);
      postMessageTyped({ type: "done" });
    }
  } catch (error: any) {
    postMessageTyped({
      type: "error",
      message: error?.message ?? String(error),
    });
  }
};
