import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { getRenderState } from "./RenderEngine";
import { renderFrame } from "./CanvasCompositor";
import type { TimelineModel } from "./types";
import type { ClipRange } from "../store/types";
import { runFfmpeg } from "../services/FfmpegService";

const FRAME_CACHE_DIR = "sve-frame-export";

interface FrameExportOptions {
  videoSrc: string;
  videoPath: string;
  clips: ClipRange[];
  timelineModel: TimelineModel;
  outputPath: string;
  fps?: number;
  onProgress?: (percent: number, status: string) => void;
}

async function ensureDir(path: string): Promise<void> {
  if (!(await exists(path))) {
    await mkdir(path, { recursive: true });
  }
}

function createVideoElement(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error("Failed to load video for export"));
    video.src = src;
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(time, video.duration || 0));
    if (Math.abs(video.currentTime - target) < 0.001) {
      resolve();
      return;
    }
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
    video.currentTime = target;
  });
}

function frameToSourceTime(
  frameIndex: number,
  fps: number,
  clips: ClipRange[],
): number {
  let remaining = frameIndex / fps;
  for (const clip of clips) {
    const len = Math.max(0, clip.end_time - clip.start_time);
    if (remaining <= len + 0.0001) {
      return clip.start_time + remaining;
    }
    remaining -= len;
  }
  const last = clips[clips.length - 1];
  return last ? last.end_time : 0;
}

function totalClipDuration(clips: ClipRange[]): number {
  return clips.reduce(
    (sum, c) => sum + Math.max(0, c.end_time - c.start_time),
    0,
  );
}

function buildAudioConcatFilter(clips: ClipRange[]): string {
  if (clips.length === 0) return "";

  const parts: string[] = [];
  const labels: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    parts.push(
      `[1:a]atrim=start=${clips[i].start_time}:end=${clips[i].end_time},asetpts=PTS-STARTPTS[a${i}]`,
    );
    labels.push(`[a${i}]`);
  }

  if (clips.length === 1) {
    return parts[0].replace(`[a0]`, `[aout]`);
  }

  parts.push(
    `${labels.join("")}concat=n=${clips.length}:v=0:a=1[aout]`,
  );
  return parts.join("; ");
}

/**
 * Frame-by-frame export pipeline.
 *
 * 1. Creates a hidden video element for seeking.
 * 2. For each frame: seek video, composite video + overlays to canvas,
 *    export to PNG.
 * 3. Runs ffmpeg with the PNG image sequence + audio from the original
 *    video file.
 *
 * Both preview and export use the same RenderEngine + CanvasCompositor
 * for pixel-identical overlay rendering.
 */
export async function exportWithFrames(
  options: FrameExportOptions,
): Promise<string> {
  const {
    videoSrc,
    videoPath,
    clips,
    timelineModel,
    outputPath,
    onProgress,
  } = options;
  const fps = options.fps ?? 30;
  const duration = totalClipDuration(clips);
  const totalFrames = Math.ceil(duration * fps);

  if (totalFrames <= 0) {
    throw new Error("No frames to export");
  }

  onProgress?.(0, "Preparing frame export...");

  // Create hidden video element for frame capture
  const exportVideo = await createVideoElement(videoSrc);

  // Create temp directory for frame images
  const root = await appCacheDir();
  const sessionId = `export-${Date.now()}`;
  const sessionDir = await join(root, FRAME_CACHE_DIR, sessionId);
  await ensureDir(sessionDir);

  // Create compositing canvases
  const videoWidth = exportVideo.videoWidth || 1920;
  const videoHeight = exportVideo.videoHeight || 1080;

  const canvas = document.createElement("canvas");
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot create canvas context");

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = videoWidth;
  overlayCanvas.height = videoHeight;
  const overlayCtx = overlayCanvas.getContext("2d");
  if (!overlayCtx) throw new Error("Cannot create overlay canvas context");

  const framePaths: string[] = [];

  try {
    // ---- Phase 1: Render frames (0–80% progress) ----
    for (let i = 0; i < totalFrames; i++) {
      const sourceTime = frameToSourceTime(i, fps, clips);

      await seekTo(exportVideo, sourceTime);

      // Draw video frame
      ctx.clearRect(0, 0, videoWidth, videoHeight);
      ctx.drawImage(exportVideo, 0, 0, videoWidth, videoHeight);

      // Compute and draw overlays using the unified render pipeline
      const renderState = getRenderState(timelineModel, sourceTime);
      if (renderState.overlays.length > 0) {
        await renderFrame(
          overlayCtx,
          renderState,
          videoWidth,
          videoHeight,
        );
        ctx.drawImage(overlayCanvas, 0, 0);
      }

      // Export frame as PNG
      const blob: Blob | null = await new Promise((r) =>
        canvas.toBlob(r, "image/png"),
      );
      if (!blob) continue;

      const buffer = await blob.arrayBuffer();
      const frameName = `frame_${i.toString().padStart(6, "0")}.png`;
      const framePath = await join(sessionDir, frameName);
      await writeFile(framePath, new Uint8Array(buffer));
      framePaths.push(framePath);

      const progress = ((i + 1) / totalFrames) * 80;
      onProgress?.(
        progress,
        `Rendering frame ${i + 1}/${totalFrames}`,
      );
    }

    if (framePaths.length === 0) {
      throw new Error("No frames were rendered");
    }

    // ---- Phase 2: Encode with ffmpeg (80–100% progress) ----
    onProgress?.(80, "Encoding video...");

    const framePattern = await join(sessionDir, "frame_%06d.png");
    const audioFilter = buildAudioConcatFilter(clips);

    const ffmpegArgs = [
      "-y",
      "-progress",
      "pipe:1",
      "-nostats",
      "-framerate",
      String(fps),
      "-i",
      framePattern,
      "-i",
      videoPath,
      ...(audioFilter.length > 0
        ? [
            "-filter_complex",
            audioFilter,
            "-map",
            "0:v",
            "-map",
            "[aout]",
          ]
        : ["-map", "0:v", "-an"]),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      ...(audioFilter.length > 0
        ? ["-c:a", "aac", "-b:a", "192k"]
        : []),
      outputPath,
    ];

    await runFfmpeg(ffmpegArgs, {
      onProgress: (payload) => {
        if (payload.key === "frame") {
          const frame = parseInt(payload.value, 10);
          if (Number.isFinite(frame)) {
            const pct = 80 + (frame / totalFrames) * 20;
            onProgress?.(
              Math.min(99, pct),
              `Encoding frame ${frame}/${totalFrames}`,
            );
          }
        }
        if (payload.key === "progress" && payload.value === "end") {
          onProgress?.(100, "Export complete");
        }
      },
    });

    return outputPath;
  } finally {
    // Cleanup temp frames
    for (const fp of framePaths) {
      try {
        await remove(fp);
      } catch {
        /* ignore */
      }
    }
    try {
      await remove(sessionDir);
    } catch {
      /* ignore */
    }

    // Release hidden video element
    exportVideo.src = "";
    exportVideo.load();
  }
}
