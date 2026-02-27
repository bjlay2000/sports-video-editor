/**
 * Standalone ffmpeg-only export pipeline.
 *
 * ZERO UI/store imports.  Accepts fully-resolved data only.
 *
 * Filter order:
 *   1. Trim source into segments
 *   2. Concat segments → [vcat][aout]
 *   3. Scale [vcat] to export resolution → [vscaled]
 *   4. Overlay chain starting from [vscaled]
 *   5. Final output label: [vout]
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile, remove, stat } from "@tauri-apps/plugin-fs";
import { runFfmpeg } from "../services/FfmpegService";
import {
  beginExportLogSession,
  endExportLogSession,
  logExportEvent,
} from "../services/ExportLogService";
import {
  resolveEncoder,
  encoderDisplayName,
  vendorDisplayName,
  type QualityProfile,
  type EncoderName,
  type ResolvedEncoder,
} from "../services/HardwareDetection";
import type { Overlay, Keyframe } from "../engine/types";

/* ================================================================
 *  Export Logger — timestamped console log for every export step
 * ================================================================ */

const exportLogEntries: { time: string; process: string }[] = [];
let onProcessChange: ((process: string) => void) | null = null;

function exportLog(process: string) {
  const now = new Date();
  const ts = now.toLocaleTimeString("en-US", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
  const entry = { time: ts, process };
  exportLogEntries.push(entry);
  logExportEvent("ExportEngine", process);
  onProcessChange?.(process);
}

/** Get all log entries for the current/last export. */
export function getExportLog() {
  return [...exportLogEntries];
}

/* ================================================================
 *  ClipRange — local definition to avoid store import
 * ================================================================ */

interface ClipRange {
  start_time: number;
  end_time: number;
}

/* ================================================================
 *  ExportConfig contract
 * ================================================================ */

export interface ExportConfig {
  videoPath: string;
  clips: ClipRange[];
  overlays: Overlay[];
  outputPath: string;
  exportWidth: number;
  exportHeight: number;
  fps: number;
  qualityProfile?: QualityProfile;
  onProgress?: (percent: number, status: string) => void;
  onProcessChange?: (process: string) => void;
}

/* ================================================================
 *  Encoder Detection  — delegated to HardwareDetection service
 *
 *  The HardwareDetection module:
 *  1. Runs `ffmpeg -encoders` once, parses available HW encoders
 *  2. Detects GPU vendor (NVIDIA / Intel / AMD / CPU-only)
 *  3. Builds a priority chain: AV1 → HEVC → H264 per vendor
 *  4. Maps quality profiles to correct per-vendor ffmpeg flags
 *     (NVENC -cq, QSV -global_quality, AMF -qp_i/-qp_p, CPU -crf)
 * ================================================================ */

export interface ExportResult {
  outputPath: string;
  totalDurationSec: number;
  totalFrames: number;
  fps: number;
  exportWidth: number;
  exportHeight: number;
  encoder: string;
  encoderDisplay: string;
  vendorDisplay: string;
  encodeElapsedMs: number;
  totalElapsedMs: number;
}

/* ================================================================
 *  Highlight export (segmented architecture)
 *
 *  Why this exists:
 *  - The previous highlight architecture decoded the full source timeline
 *    and trimmed in a giant filtergraph (trim/atrim + concat).
 *  - On long videos with many highlights, that graph can increase GPU memory
 *    pressure and trigger stalls/freezes.
 *
 *  New approach:
 *  1) Seek each highlight segment via input seeking (-ss before -i)
 *  2) Encode each segment independently to temp MP4 files
 *  3) Concatenate with concat demuxer using -c copy (no re-encode)
 *
 *  This decodes only needed ranges, reduces VRAM pressure, and keeps
 *  QSV acceleration + quality controls.
 * ================================================================ */

interface HighlightSegment {
  start: number;
  end: number;
}

function formatSec(value: number): string {
  return Math.max(0, value).toFixed(6);
}

function concatFilePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.replace(/'/g, "'\\''");
}

function applyQsvSegmentTunables(codecArgs: string[], isQsv: boolean): string[] {
  if (!isQsv) return [...codecArgs];

  const args = [...codecArgs];
  const hasAsyncDepth = args.includes("-async_depth");

  if (!hasAsyncDepth) {
    args.push("-async_depth", "2");
  }

  return args;
}

function buildSegmentArgs(params: {
  videoPath: string;
  startSec: number;
  durationSec: number;
  exportWidth: number;
  exportHeight: number;
  fps: number;
  encoder: ResolvedEncoder;
  outputPath: string;
}): string[] {
  const {
    videoPath,
    startSec,
    durationSec,
    exportWidth,
    exportHeight,
    fps,
    encoder,
    outputPath,
  } = params;

  const isQsvEncoder = encoder.name.endsWith("_qsv");
  const codecArgs = applyQsvSegmentTunables(encoder.codecArgs, isQsvEncoder);

  const args: string[] = ["-y"];

  args.push("-ss", formatSec(startSec));
  args.push("-t", formatSec(durationSec));

  if (isQsvEncoder) {
    args.push("-hwaccel", "qsv", "-hwaccel_output_format", "qsv");
  } else if (encoder.hwaccelArgs.length > 0) {
    args.push(...encoder.hwaccelArgs);
  }

  args.push("-i", videoPath);

  if (isQsvEncoder) {
    args.push("-vf", `scale_qsv=w=${exportWidth}:h=${exportHeight}:format=nv12`);
  } else {
    args.push("-vf", `scale=${exportWidth}:${exportHeight}:flags=lanczos`);
    args.push("-pix_fmt", "yuv420p");
  }

  args.push("-r", String(fps));
  args.push(...codecArgs);
  args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1");
  args.push(outputPath);

  return args;
}

export async function runHighlightExportSegmented(config: ExportConfig): Promise<ExportResult> {
  exportLogEntries.length = 0;
  onProcessChange = config.onProcessChange ?? null;
  beginExportLogSession(`output=${config.outputPath} mode=segmented-highlights`);
  const exportStartedAt = Date.now();

  const {
    videoPath,
    clips,
    overlays,
    outputPath,
    exportWidth,
    exportHeight,
    fps,
    qualityProfile = "fast",
    onProgress,
  } = config;

  let tempDir: string | null = null;
  let concatListPath: string | null = null;
  const segmentFiles: string[] = [];
  let concatCompleted = false;

  try {
    exportLog("runHighlightExportSegmented: === EXPORT STARTED ===");

    if (overlays.length > 0) {
      throw new Error("Highlight export with overlays is not supported in segmented mode");
    }

    if (clips.length === 0) {
      throw new Error("No highlight segments to export");
    }

    const totalDuration = clips.reduce(
      (sum, clip) => sum + Math.max(0, clip.end_time - clip.start_time),
      0,
    );
    const totalFrames = Math.ceil(totalDuration * fps);
    if (totalFrames <= 0) {
      throw new Error("No frames to export");
    }

    onProgress?.(0, "Preparing highlight export...");

    exportLog(`runHighlightExportSegmented: resolving encoder for profile=${qualityProfile}`);
    const encoder = await resolveEncoder(qualityProfile);
    const encoderLabel = encoderDisplayName(encoder.name);
    const vendorLabel = vendorDisplayName(encoder.vendor);
    const qsvActive = encoder.name.endsWith("_qsv");
    exportLog(
      `runHighlightExportSegmented: encoder=${encoder.name} (${encoderLabel}) vendor=${vendorLabel} qsvActive=${qsvActive}`,
    );

    onProgress?.(3, `Detected: ${encoderLabel} (${vendorLabel})`);

    const cacheRoot = await appCacheDir();
    tempDir = await join(cacheRoot, OVERLAY_CACHE_DIR, `highlight-segments-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    const segmentSpecs: HighlightSegment[] = clips.map((clip) => ({
      start: clip.start_time,
      end: clip.end_time,
    }));

    exportLog(`runHighlightExportSegmented: encoding ${segmentSpecs.length} segments`);
    const encodeStartedAt = Date.now();

    const segmentTotalDuration = segmentSpecs.reduce((sum, s) => sum + (s.end - s.start), 0);
    let segmentEncodedDuration = 0;

    for (let index = 0; index < segmentSpecs.length; index++) {
      const segment = segmentSpecs[index];
      const segmentDuration = Math.max(0.001, segment.end - segment.start);
      const segmentPath = await join(
        tempDir,
        `temp_segment_${String(index + 1).padStart(3, "0")}.mp4`,
      );
      segmentFiles.push(segmentPath);

      exportLog(
        `runHighlightExportSegmented: segment ${index + 1}/${segmentSpecs.length} start=${segment.start.toFixed(3)} end=${segment.end.toFixed(3)} duration=${segmentDuration.toFixed(3)}s`,
      );
      onProgress?.(
        Math.min(90, 5 + (segmentEncodedDuration / segmentTotalDuration) * 85),
        `Encoding segment ${index + 1}/${segmentSpecs.length}`,
      );

      let segmentOutSeconds = 0;

      await runFfmpeg(
        buildSegmentArgs({
          videoPath,
          startSec: segment.start,
          durationSec: segmentDuration,
          exportWidth,
          exportHeight,
          fps,
          encoder,
          outputPath: segmentPath,
        }),
        {
          onProgress: (payload) => {
            if (payload.key === "out_time_us" || payload.key === "out_time_ms") {
              const parsed = Number.parseInt(payload.value, 10);
              if (Number.isFinite(parsed) && parsed > 0) {
                const outSec = parsed / 1_000_000;
                if (outSec > segmentOutSeconds) {
                  segmentOutSeconds = outSec;
                }

                const currentGlobalDuration = Math.min(
                  segmentTotalDuration,
                  segmentEncodedDuration + Math.min(segmentDuration, segmentOutSeconds),
                );
                const percent = Math.min(94, 5 + (currentGlobalDuration / segmentTotalDuration) * 89);
                onProgress?.(
                  percent,
                  `Encoding segment ${index + 1}/${segmentSpecs.length} (${Math.min(100, (segmentOutSeconds / segmentDuration) * 100).toFixed(0)}%)`,
                );
              }
            }
          },
          stallTimeoutMs: 90_000,
        },
      );

      segmentEncodedDuration += segmentDuration;
      onProgress?.(
        Math.min(94, 5 + (segmentEncodedDuration / segmentTotalDuration) * 89),
        `Segment ${index + 1}/${segmentSpecs.length} complete`,
      );
    }

    if (segmentFiles.length === 0) {
      throw new Error("No segment files were generated");
    }

    exportLog("runHighlightExportSegmented: building concat list");
    concatListPath = await join(tempDir, "segments.txt");
    const concatBody = segmentFiles
      .map((filePath) => `file '${concatFilePath(filePath)}'`)
      .join("\n");
    await writeFile(concatListPath, new TextEncoder().encode(`${concatBody}\n`));

    exportLog("runHighlightExportSegmented: concatenating segments via demuxer (-c copy)");
    onProgress?.(95, "Concatenating segments...");

    await runFfmpeg(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        outputPath,
      ],
      {
        onProgress: (payload) => {
          if (payload.key === "progress" && payload.value === "end") {
            onProgress?.(100, "Export complete");
          }
        },
        stallTimeoutMs: 60_000,
      },
    );

    concatCompleted = true;

    const totalElapsedMs = Date.now() - exportStartedAt;
    const encodeElapsedMs = Date.now() - encodeStartedAt;
    exportLog(`runHighlightExportSegmented: === EXPORT FINISHED === total=${totalElapsedMs}ms`);
    endExportLogSession(`output=${outputPath}`);

    return {
      outputPath,
      totalDurationSec: totalDuration,
      totalFrames,
      fps,
      exportWidth,
      exportHeight,
      encoder: encoder.name,
      encoderDisplay: encoderLabel,
      vendorDisplay: vendorLabel,
      encodeElapsedMs,
      totalElapsedMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exportLog(`runHighlightExportSegmented: === EXPORT FAILED === ${message}`);
    endExportLogSession(`output=${outputPath} status=failed`);
    throw error;
  } finally {
    if (concatCompleted) {
      for (const segmentPath of segmentFiles) {
        try {
          await remove(segmentPath);
        } catch {
          /* ignore cleanup failures */
        }
      }
      if (concatListPath) {
        try {
          await remove(concatListPath);
        } catch {
          /* ignore cleanup failures */
        }
      }
      if (tempDir) {
        try {
          await remove(tempDir, { recursive: true });
        } catch {
          /* ignore cleanup failures */
        }
      }
    } else {
      if (tempDir) {
        exportLog(`runHighlightExportSegmented: temp files retained for diagnostics at ${tempDir}`);
      }
    }

    onProcessChange = null;
  }
}



/* ================================================================
 *  Post-concat timeline normalization
 * ================================================================ */

interface TimeSegment {
  start: number;
  end: number;
}

/**
 * Map a source-timeline range into one or more post-concat segments.
 * An overlay that spans multiple clips produces multiple segments.
 */
function normalizeTimeToPostConcat(
  sourceStart: number,
  sourceEnd: number,
  clips: ClipRange[],
): TimeSegment[] {
  const segments: TimeSegment[] = [];
  let offset = 0;

  for (const clip of clips) {
    const overlapStart = Math.max(sourceStart, clip.start_time);
    const overlapEnd = Math.min(sourceEnd, clip.end_time);

    if (overlapStart < overlapEnd) {
      segments.push({
        start: offset + (overlapStart - clip.start_time),
        end: offset + (overlapEnd - clip.start_time),
      });
    }

    offset += clip.end_time - clip.start_time;
  }

  return segments;
}

/**
 * Map a single source-timeline timestamp to post-concat time.
 * Returns null if the timestamp falls outside all clips.
 */
function remapTimeToPostConcat(
  sourceTime: number,
  clips: ClipRange[],
): number | null {
  let offset = 0;

  for (const clip of clips) {
    if (sourceTime >= clip.start_time && sourceTime <= clip.end_time) {
      return offset + (sourceTime - clip.start_time);
    }
    offset += clip.end_time - clip.start_time;
  }

  return null;
}

/* ================================================================
 *  FFmpeg expression builders
 * ================================================================ */

/** Build an enable expression from post-concat time segments. */
function buildEnableExpr(segments: TimeSegment[]): string {
  if (segments.length === 0) return "0";
  return segments
    .map((s) => `between(t,${s.start.toFixed(4)},${s.end.toFixed(4)})`)
    .join("+");
}

/**
 * Build a piecewise-linear ffmpeg expression for a keyframed property.
 * Uses only ffmpeg expression primitives (if / lt / between).
 */
function buildKeyframeExpr(
  baseValue: number,
  keyframes: Keyframe[],
  property: "x" | "y" | "scale" | "rotation" | "opacity",
  clips: ClipRange[],
): string {
  const relevant = keyframes
    .filter((kf) => kf[property] !== undefined)
    .map((kf) => ({
      time: remapTimeToPostConcat(kf.time, clips),
      value: kf[property] as number,
    }))
    .filter((kf): kf is { time: number; value: number } => kf.time !== null)
    .sort((a, b) => a.time - b.time);

  if (relevant.length === 0) return String(baseValue);

  // Piecewise linear:
  //   if(lt(t,t0), base, if(lt(t,t1), lerp(v0,v1), ... lastValue))
  let expr = String(relevant[relevant.length - 1].value);

  for (let i = relevant.length - 1; i > 0; i--) {
    const prev = relevant[i - 1];
    const curr = relevant[i];
    const range = curr.time - prev.time;
    if (range <= 0) continue;
    const lerp =
      `${prev.value}+(${curr.value - prev.value})*(t-${prev.time.toFixed(4)})/${range.toFixed(4)}`;
    expr = `if(lt(t,${curr.time.toFixed(4)}),${lerp},${expr})`;
  }

  // Before first keyframe → base value
  expr = `if(lt(t,${relevant[0].time.toFixed(4)}),${baseValue},${expr})`;

  return expr;
}

/* ================================================================
 *  Overlay pre-rendering (text / image → PNG on disk)
 * ================================================================ */

const OVERLAY_CACHE_DIR = "sve-export-overlays";

async function ensureOverlayCacheDir(): Promise<string> {
  exportLog("ensureOverlayCacheDir: creating/checking cache directory");
  const root = await appCacheDir();
  const dir = await join(root, OVERLAY_CACHE_DIR);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/* ---- Drawing helpers (mirrors OverlayRenderWorker visuals) ---- */

function roundRectPath(
  ctx: OffscreenCanvasRenderingContext2D,
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

/**
 * Render a text / scoreboard overlay to a PNG byte buffer.
 * The PNG is rendered at the overlay's base dimensions (no position baked in).
 */
async function renderTextOverlayToPng(overlay: Overlay): Promise<Uint8Array> {
  exportLog(`renderTextOverlayToPng: rendering overlay "${overlay.id}" (${overlay.text ?? 'no text'})`);
  const w = Math.max(1, Math.round(overlay.base.width));
  const h = Math.max(1, Math.round(overlay.base.height));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot create OffscreenCanvas 2d context");

  ctx.clearRect(0, 0, w, h);

  // Background with shadow
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 15;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  roundRectPath(ctx, 0, 0, w, h, 12);
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fill();
  ctx.shadowColor = "transparent";

  // Text content
  if (overlay.text) {
    const fontSize = overlay.fontSize ?? 24;
    const fontFamily = overlay.fontFamily ?? "Inter, sans-serif";
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = overlay.color ?? "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxWidth = Math.max(10, w - 24);
    const words = overlay.text.split(/\s+/);
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

    const lineHeight = fontSize * 1.1;
    const totalH = lineHeight * lines.length;
    for (let i = 0; i < lines.length; i++) {
      const y = h / 2 - totalH / 2 + lineHeight * i + lineHeight / 2;
      ctx.fillText(lines[i], w / 2, y, maxWidth);
    }
  }

  // Border stroke
  roundRectPath(ctx, 0, 0, w, h, 12);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Resolve an imageSrc value (Tauri asset URL, data URL, or file path) to a
 * filesystem path that ffmpeg can read.
 */
function resolveAssetPath(src: string): string {
  if (src.startsWith("asset://localhost/")) {
    return decodeURIComponent(src.slice("asset://localhost/".length));
  }
  if (src.startsWith("http://asset.localhost/")) {
    return decodeURIComponent(src.slice("http://asset.localhost/".length));
  }
  if (src.startsWith("https://asset.localhost/")) {
    return decodeURIComponent(src.slice("https://asset.localhost/".length));
  }
  return src;
}

/* ---- PreparedOverlay ---- */

interface PreparedOverlay {
  overlay: Overlay;
  pngPath: string;
  segments: TimeSegment[];
  tempFile: boolean;
}

async function prepareOverlays(
  overlays: Overlay[],
  clips: ClipRange[],
): Promise<PreparedOverlay[]> {
  exportLog(`prepareOverlays: processing ${overlays.length} overlays`);
  const dir = await ensureOverlayCacheDir();
  const prepared: PreparedOverlay[] = [];

  const visible = [...overlays]
    .filter((o) => o.visible)
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const overlay of visible) {
    const segments = normalizeTimeToPostConcat(
      overlay.startTime,
      overlay.endTime,
      clips,
    );
    if (segments.length === 0) continue;

    let pngPath: string;
    let tempFile = false;

    if (overlay.type === "image" && overlay.imageSrc) {
      const src = overlay.imageSrc;

      if (src.startsWith("data:")) {
        exportLog(`prepareOverlays: decoding data URL for overlay "${overlay.id}"`);
        // Data URL → decode and write to temp file
        const match = src.match(/^data:image\/\w+;base64,(.+)$/);
        if (!match) continue;
        const binary = atob(match[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        pngPath = await join(dir, `img-${overlay.id}-${Date.now()}.png`);
        await writeFile(pngPath, bytes);
        tempFile = true;
      } else {
        exportLog(`prepareOverlays: using file path for image overlay "${overlay.id}"`);
        pngPath = resolveAssetPath(src);
      }
    } else {
      // Text / scoreboard → render to PNG
      const pngBytes = await renderTextOverlayToPng(overlay);
      pngPath = await join(dir, `text-${overlay.id}-${Date.now()}.png`);
      await writeFile(pngPath, pngBytes);
      tempFile = true;
    }

    prepared.push({ overlay, pngPath, segments, tempFile });
  }

  exportLog(`prepareOverlays: ${prepared.length} overlays prepared for export`);
  return prepared;
}

/* ================================================================
 *  Deterministic filtergraph generation
 * ================================================================ */

function buildFiltergraph(
  clips: ClipRange[],
  overlays: PreparedOverlay[],
  exportWidth: number,
  exportHeight: number,
  totalDuration: number,
  useQsvHardwareFilters: boolean,
): string {
  exportLog(
    `buildFiltergraph: ${clips.length} clips, ${overlays.length} overlays, ${exportWidth}x${exportHeight}, duration=${totalDuration.toFixed(2)}s qsvFilters=${useQsvHardwareFilters}`,
  );
  const filters: string[] = [];

  /* ---- 1. Trim source into segments ---- */
  exportLog(`buildFiltergraph: trimming ${clips.length} source segments`);
  for (let i = 0; i < clips.length; i++) {
    filters.push(
      `[0:v]trim=start=${clips[i].start_time}:end=${clips[i].end_time},setpts=PTS-STARTPTS[v${i}]`,
    );
    filters.push(
      `[0:a]atrim=start=${clips[i].start_time}:end=${clips[i].end_time},asetpts=PTS-STARTPTS[a${i}]`,
    );
  }

  /* ---- 2. Concat → [vcat][aconcat] ---- */
  exportLog("buildFiltergraph: concatenating segments");
  const vLabels = clips.map((_, i) => `[v${i}]`).join("");
  const aLabels = clips.map((_, i) => `[a${i}]`).join("");
  filters.push(`${vLabels}concat=n=${clips.length}:v=1:a=0[vcat]`);
  filters.push(`${aLabels}concat=n=${clips.length}:v=0:a=1[aconcat]`);

  // Enforce strict post-concat bounds for both streams
  filters.push(
    `[vcat]trim=duration=${totalDuration.toFixed(4)},setpts=PTS-STARTPTS[vbase]`,
  );
  filters.push(
    `[aconcat]atrim=duration=${totalDuration.toFixed(4)},asetpts=PTS-STARTPTS[aout]`,
  );

  /* ---- 3. Scale [vbase] → [vscaled] (never scale after overlay) ---- */
  exportLog(`buildFiltergraph: scaling to ${exportWidth}x${exportHeight}`);
  const scaleOut = overlays.length > 0 ? "vscaled" : "vout";
  if (useQsvHardwareFilters) {
    filters.push(
      `[vbase]scale_qsv=w=${exportWidth}:h=${exportHeight}:format=nv12[${scaleOut}]`,
    );
  } else {
    filters.push(
      `[vbase]scale=${exportWidth}:${exportHeight}:flags=lanczos[${scaleOut}]`,
    );
  }

  /* ---- 4. Overlay chain starting from [vscaled] ---- */
  if (overlays.length > 0) {
    exportLog(`buildFiltergraph: building overlay chain (${overlays.length} overlays)`);
    let prevLabel = "vscaled";

    for (let i = 0; i < overlays.length; i++) {
      const prep = overlays[i];
      const ov = prep.overlay;
      const inputIdx = i + 1; // [0] = source video, [1+] = overlay PNGs
      const isLast = i === overlays.length - 1;
      const outLabel = isLast ? "vout" : `vtmp${i}`;

      /* -- Overlay input processing chain -- */
      const chain: string[] = [];

      // Scale
      const baseScale = ov.base.scale ?? 1;
      const scaleExpr = buildKeyframeExpr(baseScale, ov.keyframes, "scale", clips);
      const hasAnimatedScale = ov.keyframes.some((kf) => kf.scale !== undefined);

      if (scaleExpr !== "1" || hasAnimatedScale) {
        const evalOpt = hasAnimatedScale ? ":eval=frame" : "";
        chain.push(
          `scale=w='trunc(iw*(${scaleExpr})/2)*2':h='trunc(ih*(${scaleExpr})/2)*2':flags=lanczos${evalOpt}`,
        );
      }

      // Opacity (static base via colorchannelmixer)
      const baseOpacity = ov.base.opacity ?? 1;
      if (baseOpacity < 1) {
        chain.push(`format=rgba,colorchannelmixer=aa=${baseOpacity}`);
      }

      // Fade in / out (detected from opacity keyframes)
      const opacityKFs = ov.keyframes
        .filter((kf) => kf.opacity !== undefined)
        .sort((a, b) => a.time - b.time);

      if (opacityKFs.length > 0) {
        // Fade in: first keyframe opacity ≈ 0 → later keyframe opacity ≈ 1
        const firstOp = opacityKFs[0];
        if (firstOp.opacity !== undefined && firstOp.opacity < 0.1) {
          const fadeInTarget = opacityKFs.find(
            (kf) => kf.opacity !== undefined && kf.opacity > 0.9,
          );
          if (fadeInTarget) {
            const st = remapTimeToPostConcat(firstOp.time, clips);
            const et = remapTimeToPostConcat(fadeInTarget.time, clips);
            if (st !== null && et !== null && et - st > 0) {
              chain.push(
                `fade=t=in:st=${st.toFixed(4)}:d=${(et - st).toFixed(4)}:alpha=1`,
              );
            }
          }
        }

        // Fade out: last keyframe opacity ≈ 0 ← earlier keyframe opacity ≈ 1
        const lastOp = opacityKFs[opacityKFs.length - 1];
        if (lastOp.opacity !== undefined && lastOp.opacity < 0.1) {
          const fadeOutSource = [...opacityKFs]
            .reverse()
            .find((kf) => kf.opacity !== undefined && kf.opacity > 0.9);
          if (fadeOutSource) {
            const st = remapTimeToPostConcat(fadeOutSource.time, clips);
            const et = remapTimeToPostConcat(lastOp.time, clips);
            if (st !== null && et !== null && et - st > 0) {
              chain.push(
                `fade=t=out:st=${st.toFixed(4)}:d=${(et - st).toFixed(4)}:alpha=1`,
              );
            }
          }
        }
      }

      // Rotation
      const baseRotation = ov.base.rotation ?? 0;
      const rotExpr = buildKeyframeExpr(baseRotation, ov.keyframes, "rotation", clips);
      const hasAnimatedRot = ov.keyframes.some((kf) => kf.rotation !== undefined);

      if (rotExpr !== "0" || hasAnimatedRot) {
        chain.push(
          `rotate=(${rotExpr})*PI/180:ow=rotw(iw):oh=roth(ih):c=0x00000000`,
        );
      }

      // Build label for processed overlay input
      const ovLabel = `ov${i}`;
      if (chain.length > 0) {
        filters.push(`[${inputIdx}:v]${chain.join(",")}[${ovLabel}]`);
      } else {
        filters.push(`[${inputIdx}:v]null[${ovLabel}]`);
      }

      // Position expressions (ffmpeg overlay supports t-based expressions)
      const xExpr = buildKeyframeExpr(ov.base.x, ov.keyframes, "x", clips);
      const yExpr = buildKeyframeExpr(ov.base.y, ov.keyframes, "y", clips);

      // Enable expression from post-concat time segments
      const enableExpr = buildEnableExpr(prep.segments);

      // Overlay composition
      filters.push(
        `[${prevLabel}][${ovLabel}]overlay=x=${xExpr}:y=${yExpr}:enable='${enableExpr}':eof_action=pass:shortest=1:repeatlast=0:format=auto[${outLabel}]`,
      );

      prevLabel = outLabel;
    }
  }

  return filters.join(";");
}

/* ================================================================
 *  runExport — single public entry point
 * ================================================================ */

export async function runExport(config: ExportConfig): Promise<ExportResult> {
  // Clear previous log entries for this export
  exportLogEntries.length = 0;
  onProcessChange = config.onProcessChange ?? null;
  beginExportLogSession(`output=${config.outputPath}`);
  const exportStartedAt = Date.now();

  exportLog("runExport: === EXPORT STARTED ===");
  const {
    videoPath,
    clips,
    overlays,
    outputPath,
    exportWidth,
    exportHeight,
    fps,
    qualityProfile = "fast",
    onProgress,
  } = config;

  try {

  // ---- Validate ----
  exportLog(`runExport: validating — ${clips.length} clips, ${overlays.length} overlays, output=${outputPath}`);
  const totalDuration = clips.reduce(
    (sum, c) => sum + Math.max(0, c.end_time - c.start_time),
    0,
  );
  const totalFrames = Math.ceil(totalDuration * fps);
  exportLog(`runExport: totalDuration=${totalDuration.toFixed(2)}s, totalFrames=${totalFrames}, resolution=${exportWidth}x${exportHeight}, fps=${fps}`);
  if (totalFrames <= 0) throw new Error("No frames to export");
  if (exportWidth <= 0 || exportHeight <= 0) {
    throw new Error("Invalid export dimensions");
  }

  exportLog("runExport: preparing export...");
  onProgress?.(0, "Preparing export...");

  // ---- Prepare overlay PNGs ----
  exportLog("runExport: preparing overlay PNGs");
  const overlaysStartedAt = Date.now();
  const preparedOverlays = await prepareOverlays(overlays, clips);
  exportLog(
    `runExport: overlays prepared (${preparedOverlays.length} ready) in ${Date.now() - overlaysStartedAt}ms`,
  );

  // ---- Detect encoder ----
  exportLog(`runExport: resolving encoder for profile=${qualityProfile}`);
  const encoderStartedAt = Date.now();
  const encoder: ResolvedEncoder = await resolveEncoder(qualityProfile);
  const encoderLabel = encoderDisplayName(encoder.name);
  const vendorLabel = vendorDisplayName(encoder.vendor);
  exportLog(`runExport: encoder resolved — ${encoder.name} (${encoderLabel}) vendor=${vendorLabel} in ${Date.now() - encoderStartedAt}ms`);
  onProgress?.(5, `Detected: ${encoderLabel} (${vendorLabel})`);

  // ---- Build filtergraph ----
  exportLog("runExport: building filtergraph");
  const filtergraphStartedAt = Date.now();
  const qsvEncoderSelected = encoder.name.endsWith("_qsv");
  const useQsvHardwareFilters = qsvEncoderSelected && preparedOverlays.length === 0;
  const useHwDecodeForPrimaryPath = !qsvEncoderSelected || useQsvHardwareFilters;
  if (qsvEncoderSelected && preparedOverlays.length > 0) {
    exportLog(
      "runExport: QSV encoder selected, but overlays require software overlay filter; using software filtergraph path",
    );
  }

  const filterComplex = buildFiltergraph(
    clips,
    preparedOverlays,
    exportWidth,
    exportHeight,
    totalDuration,
    useQsvHardwareFilters,
  );
  exportLog(`runExport: filtergraph built in ${Date.now() - filtergraphStartedAt}ms`);

  // ---- Assemble ffmpeg command ----
  exportLog("runExport: assembling ffmpeg command");
  const buildArgs = (
    videoCodecArgs: string[],
    safeMode: boolean,
    hwaccelArgs: string[] = [],
    outputPixFmt: "yuv420p" | "nv12" | null = "yuv420p",
  ): string[] => {
    const args: string[] = ["-y"];

    // ── Hardware-accelerated decode (2–4× faster on 4K) ──
    // Placed before -i so ffmpeg uses GPU for decoding the source.
    // Frames are auto-uploaded to system RAM for the software filter graph.
    if (!safeMode && hwaccelArgs.length > 0) {
      args.push(...hwaccelArgs);
    }

    // [0] = source video
    args.push("-i", videoPath);

    // [1+] = overlay PNG inputs (looped for static images)
    for (const p of preparedOverlays) {
      args.push("-loop", "1", "-i", p.pngPath);
    }

    // Filter complex
    args.push("-filter_complex", filterComplex);

    if (safeMode) {
      args.push("-filter_threads", "1", "-filter_complex_threads", "1");
    }

    // Map outputs
    args.push("-map", "[vout]", "-map", "[aout]");

    // Stop muxing when shortest mapped stream ends
    args.push("-shortest");

    // Explicit FPS (supports 60fps cleanly)
    args.push("-r", String(fps));

    // Video encoder
    args.push(...videoCodecArgs);

    // Pixel format handling:
    // - Full QSV hardware-frames path: leave unset here to avoid
    //   software auto_scale insertion (nv12 is enforced in scale_qsv).
    // - Other paths: set explicitly for compatibility.
    if (outputPixFmt) {
      args.push("-pix_fmt", outputPixFmt);
    }

    // Audio encoder
    args.push("-c:a", "aac", "-b:a", "192k");

    // Move moov atom to file start for instant playback / streaming
    args.push("-movflags", "+faststart");

    // Progress reporting via pipe
    args.push("-progress", "pipe:1");

    // Hard cap output to post-concat timeline duration to avoid runaway renders
    args.push("-t", totalDuration.toFixed(3));

    // Output
    args.push(outputPath);

    return args;
  };

  const safeCodecArgs: string[] = [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "30",
    "-tune", "zerolatency",
    "-threads", "0",
  ];

  // ---- Execute ----
  exportLog(`runExport: starting ffmpeg encode with ${encoder.name} (${encoderLabel})`);
  const encodeStartedAt = Date.now();
  onProgress?.(10, `Encoding with ${encoderLabel}...`);
  let currentFrame = 0;
  let currentFps = "0";
  let lastPercentEmitted = -Infinity;
  let lastUiProgressAt = Date.now();
  let lastOutputSize = -1;
  let outputNoGrowthSamples = 0;

  const outputGrowthInterval = setInterval(async () => {
    try {
      const outputExists = await exists(outputPath);
      if (!outputExists) {
        exportLog("output.monitor: file does not exist yet");
        return;
      }

      const info = await stat(outputPath);
      const size = Number.isFinite(info.size) ? Number(info.size) : -1;
      if (size < 0) {
        exportLog("output.monitor: size unavailable");
        return;
      }

      if (lastOutputSize >= 0) {
        const delta = size - lastOutputSize;
        if (delta <= 0) {
          outputNoGrowthSamples += 1;
        } else {
          outputNoGrowthSamples = 0;
        }
        exportLog(
          `output.monitor: size=${size}B delta=${delta}B noGrowthSamples=${outputNoGrowthSamples}`,
        );
      } else {
        exportLog(`output.monitor: initial size=${size}B`);
      }

      lastOutputSize = size;
    } catch (error) {
      exportLog(`output.monitor: stat failed ${String(error)}`);
    }
  }, 5_000);

  const progressGapInterval = setInterval(() => {
    const elapsed = Date.now() - lastUiProgressAt;
    if (elapsed >= 10_000) {
      exportLog(
        `progress.gap: no UI progress update for ${(elapsed / 1000).toFixed(1)}s frame=${currentFrame}/${totalFrames} fps=${currentFps}`,
      );
    }
  }, 5_000);

  const handleProgress = (payload: { key: string; value: string }) => {
    if (payload.key === "frame") {
      const frame = parseInt(payload.value, 10);
      if (Number.isFinite(frame) && frame > currentFrame) {
        currentFrame = Math.min(totalFrames, frame);
      }
    }

    if (payload.key === "fps") {
      currentFps = payload.value;
    }

    if (payload.key === "out_time_ms" || payload.key === "out_time_us") {
      const outTimeValue = Number.parseInt(payload.value, 10);
      if (Number.isFinite(outTimeValue) && outTimeValue > 0) {
        const seconds = outTimeValue / 1_000_000;
        const derivedFrame = Math.floor(seconds * fps);
        if (derivedFrame > currentFrame) {
          currentFrame = Math.min(totalFrames, derivedFrame);
        }
      }
    }

    if (payload.key === "progress" && payload.value === "end") {
      exportLog("handleProgress: ffmpeg reported progress=end");
      lastUiProgressAt = Date.now();
      onProgress?.(100, "Export complete");
      return;
    }

    if (currentFrame === 0) {
      lastUiProgressAt = Date.now();
      onProgress?.(0, "Initializing encoder...");
      return;
    }

    const rawPercent = (currentFrame / totalFrames) * 100;
    const percent = Math.min(99.9, rawPercent);

    if (Math.abs(percent - lastPercentEmitted) >= 0.1) {
      lastPercentEmitted = percent;
      lastUiProgressAt = Date.now();
      onProgress?.(
        percent,
        `Rendering ${percent.toFixed(1)}% (${currentFrame}/${totalFrames}) @ ${currentFps} FPS`,
      );
    }
  };

  try {
    exportLog("runExport: spawning ffmpeg (primary encode path)");
    await runFfmpeg(
      buildArgs(
        encoder.codecArgs,
        false,
        useHwDecodeForPrimaryPath ? encoder.hwaccelArgs : [],
        useQsvHardwareFilters ? null : (qsvEncoderSelected ? "nv12" : "yuv420p"),
      ),
      {
      onProgress: handleProgress,
      stallTimeoutMs: 90_000,
      },
    );
    exportLog(`runExport: ffmpeg primary encode completed successfully in ${Date.now() - encodeStartedAt}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isStall = message.toLowerCase().includes("stalled");
    const isFilterReinitFailure =
      message.toLowerCase().includes("error reinitializing filters") ||
      message.toLowerCase().includes("function not implemented");
    exportLog(`runExport: ffmpeg primary encode failed — ${message} (stall=${isStall})`);

    if (!isStall && !isFilterReinitFailure) {
      throw error;
    }

    currentFrame = 0;
    currentFps = "0";
    lastPercentEmitted = -Infinity;

    exportLog("runExport: retrying in safe mode (CPU, single-threaded filters)");
    onProgress?.(10, "Primary encode path failed, retrying in safe mode...");

    // Safe mode: no hwaccel, CPU encoder, single-threaded filters
    await runFfmpeg(buildArgs(safeCodecArgs, true, []), {
      onProgress: handleProgress,
      stallTimeoutMs: 120_000,
    });
    exportLog(`runExport: safe mode encode completed successfully in ${Date.now() - encodeStartedAt}ms total encode time`);
  } finally {
    clearInterval(outputGrowthInterval);
    clearInterval(progressGapInterval);
    // Cleanup temp overlay files
    exportLog(`runExport: cleaning up ${preparedOverlays.filter(p => p.tempFile).length} temp overlay files`);
    for (const p of preparedOverlays) {
      if (p.tempFile) {
        try {
          await remove(p.pngPath);
        } catch {
          /* ignore cleanup failures */
        }
      }
    }
    exportLog("runExport: cleanup complete");
  }

    const totalElapsedMs = Date.now() - exportStartedAt;
    const encodeElapsedMs = Date.now() - encodeStartedAt;
    exportLog(`runExport: === EXPORT FINISHED === total=${totalElapsedMs}ms`);
    endExportLogSession(`output=${outputPath}`);
    return {
      outputPath,
      totalDurationSec: totalDuration,
      totalFrames,
      fps,
      exportWidth,
      exportHeight,
      encoder: encoder.name,
      encoderDisplay: encoderLabel,
      vendorDisplay: vendorLabel,
      encodeElapsedMs,
      totalElapsedMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exportLog(`runExport: === EXPORT FAILED === ${message}`);
    endExportLogSession(`output=${outputPath} status=failed`);
    throw error;
  } finally {
    onProcessChange = null;
  }
}
