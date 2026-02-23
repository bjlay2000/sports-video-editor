import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { useVideoStore } from "../store/videoStore";
import { useAppStore } from "../store/appStore";
import { getRenderState } from "../engine/RenderEngine";
import { renderFrame } from "../engine/CanvasCompositor";
import { deriveScoreEvents } from "../engine/scoreEvents";
import type { TimelineModel } from "../engine/types";

const OVERLAY_FOLDER = "sve-overlay-cache";

async function ensureOverlayCacheDir() {
  const root = await appCacheDir();
  const dir = await join(root, OVERLAY_FOLDER);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Renders the current overlay state to a single PNG file using the unified
 * RenderEngine + CanvasCompositor pipeline. Provides a fallback path for
 * static overlay compositing.
 */
export async function createOverlayCompositeFile(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
} | null> {
  const videoState = useVideoStore.getState();
  const appState = useAppStore.getState();

  if (!videoState.showScoreboardOverlay) return null;
  if (videoState.videoWidth <= 0 || videoState.videoHeight <= 0) return null;

  const scoreEvents = deriveScoreEvents(
    appState.plays,
    appState.opponentScoreEvents,
    appState.homeScoreEvents,
  );

  const timelineModel: TimelineModel = {
    duration: videoState.duration,
    currentTime: videoState.currentTime,
    overlays: videoState.overlays,
    scoreEvents,
    videoTrack: { keyframes: videoState.videoTrackKeyframes },
  };

  const renderState = getRenderState(timelineModel, videoState.currentTime);
  if (renderState.overlays.length === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = videoState.videoWidth;
  canvas.height = videoState.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  await renderFrame(ctx, renderState, canvas.width, canvas.height);

  const blob: Blob | null = await new Promise((r) =>
    canvas.toBlob(r, "image/png"),
  );
  if (!blob) return null;

  const buffer = await blob.arrayBuffer();
  const dir = await ensureOverlayCacheDir();
  const fileName = `overlay-${Date.now()}.png`;
  const targetPath = await join(dir, fileName);
  await writeFile(targetPath, new Uint8Array(buffer));

  const cleanup = async () => {
    try {
      await remove(targetPath);
    } catch {
      /* ignore */
    }
  };

  return { path: targetPath, cleanup };
}