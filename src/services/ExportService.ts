import { invoke } from "@tauri-apps/api/core";
import { stat } from "@tauri-apps/plugin-fs";
import { ClipRange } from "../store/types";
import { useVideoStore } from "../store/videoStore";
import { useAppStore } from "../store/appStore";
import { deriveScoreEvents } from "../engine/scoreEvents";
import { runExport, type ExportConfig, type ExportResult } from "../export/ExportEngine";
import { cancelActiveFfmpeg, runFfmpeg } from "./FfmpegService";
import { logExportEvent } from "./ExportLogService";
import {
  QUALITY_PROFILE_OPTIONS,
  resolveEncoder,
  usesFastExportDimensions,
} from "./HardwareDetection";
import { recordActualExportFps } from "./ExportEstimationService";
import type { Overlay, ScoreEvent } from "../engine/types";

interface ExportProgressUpdate {
  percent: number;
  status?: string;
}

interface ExportOptions {
  onProgress?: (update: ExportProgressUpdate) => void;
  onProcessChange?: (process: string) => void;
}

export interface ExportSummary extends ExportResult {
  outputSizeBytes: number;
}

let ffmpegDiagnosticsLogged: Promise<void> | null = null;
let ffmpegPresetCommandValidationLogged = false;

async function logPresetCommandTemplatesOnce(): Promise<void> {
  if (ffmpegPresetCommandValidationLogged) return;

  for (const preset of QUALITY_PROFILE_OPTIONS) {
    const resolved = await resolveEncoder(preset);
    const templateArgs = [
      "ffmpeg",
      "-y",
      ...resolved.hwaccelArgs,
      "-i", "<input>",
      "-filter_complex", "<filtergraph>",
      "-map", "[vout]",
      "-map", "[aout]",
      "-shortest",
      "-r", "30",
      ...resolved.codecArgs,
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-t", "<duration>",
      "<output>",
    ];
    logExportEvent(
      "ExportService",
      `validation.command preset=${preset} args=[${templateArgs.join(" ")}]`,
    );
  }

  ffmpegPresetCommandValidationLogged = true;
}

async function logFfmpegDiagnosticsOnce(): Promise<void> {
  if (!ffmpegDiagnosticsLogged) {
    ffmpegDiagnosticsLogged = (async () => {
      try {
        const versionOutput = await runFfmpeg(["-hide_banner", "-version"]);
        const versionLine = versionOutput.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "unknown";
        logExportEvent("ExportService", `ffmpeg.version ${versionLine}`);
      } catch (error) {
        logExportEvent("ExportService", `ffmpeg.version failed: ${String(error)}`);
      }

      try {
        const hwaccelOutput = await runFfmpeg(["-hide_banner", "-hwaccels"]);
        const hwaccels = hwaccelOutput
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.toLowerCase().includes("hardware acceleration methods"));
        logExportEvent("ExportService", `ffmpeg.hwaccels ${hwaccels.join(", ")}`);
      } catch (error) {
        logExportEvent("ExportService", `ffmpeg.hwaccels failed: ${String(error)}`);
      }

      try {
        await logPresetCommandTemplatesOnce();
      } catch (error) {
        logExportEvent("ExportService", `validation.command failed: ${String(error)}`);
      }
    })();
  }

  await ffmpegDiagnosticsLogged;
}

function logExportInputComplexity(clips: ClipRange[], overlays: Overlay[]): void {
  const clipDurations = clips.map((clip) => Math.max(0, clip.end_time - clip.start_time));
  const totalDuration = clipDurations.reduce((sum, value) => sum + value, 0);
  const minDuration = clipDurations.length ? Math.min(...clipDurations) : 0;
  const maxDuration = clipDurations.length ? Math.max(...clipDurations) : 0;
  const tinyClipCount = clipDurations.filter((duration) => duration < 0.5).length;
  const imageOverlayCount = overlays.filter((overlay) => overlay.type === "image").length;
  const textOverlayCount = overlays.filter((overlay) => overlay.type !== "image").length;
  const keyframeCount = overlays.reduce((sum, overlay) => sum + overlay.keyframes.length, 0);

  logExportEvent(
    "ExportService",
    `input.complexity clips=${clips.length} totalDuration=${totalDuration.toFixed(3)}s minClip=${minDuration.toFixed(3)}s maxClip=${maxDuration.toFixed(3)}s tinyClips(<0.5s)=${tinyClipCount}`,
  );
  logExportEvent(
    "ExportService",
    `input.overlays total=${overlays.length} image=${imageOverlayCount} text=${textOverlayCount} keyframes=${keyframeCount}`,
  );
}

function buildFastExportDimensions(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(sourceWidth) && sourceWidth > 0 ? Math.floor(sourceWidth) : 1920;
  const safeHeight = Number.isFinite(sourceHeight) && sourceHeight > 0 ? Math.floor(sourceHeight) : 1080;
  const maxWidth = 1920;
  const maxHeight = 1080;
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight, 1);

  const scaledWidth = Math.max(2, Math.floor((safeWidth * scale) / 2) * 2);
  const scaledHeight = Math.max(2, Math.floor((safeHeight * scale) / 2) * 2);

  return { width: scaledWidth, height: scaledHeight };
}

async function attachOutputStats(result: ExportResult): Promise<ExportSummary> {
  let outputSizeBytes = 0;
  try {
    const info = await stat(result.outputPath);
    outputSizeBytes = Number.isFinite(info.size) ? Number(info.size) : 0;
  } catch {
    outputSizeBytes = 0;
  }

  // Record actual encode fps for self-learning estimation
  if (result.encodeElapsedMs > 0 && result.totalFrames > 0) {
    const actualFps = result.totalFrames / (result.encodeElapsedMs / 1000);
    const vendor = result.vendorDisplay.toLowerCase().includes("nvidia")
      ? "nvidia" as const
      : result.vendorDisplay.toLowerCase().includes("intel")
        ? "intel" as const
        : result.vendorDisplay.toLowerCase().includes("amd")
          ? "amd" as const
          : "cpu" as const;

    recordActualExportFps({
      vendor,
      encoder: result.encoder as any,
      exportWidth: result.exportWidth,
      exportHeight: result.exportHeight,
      actualFps,
    });
  }

  return {
    ...result,
    outputSizeBytes,
  };
}

/**
 * Resolve dynamic scoreboard overlays into static text overlays.
 * Each score-change interval produces a separate overlay with the correct text.
 */
function resolveOverlays(
  overlays: Overlay[],
  scoreEvents: ScoreEvent[],
): Overlay[] {
  const result: Overlay[] = [];

  for (const overlay of overlays) {
    if (overlay.dynamic?.type !== "scoreboard") {
      result.push(overlay);
      continue;
    }

    const team: "home" | "away" =
      overlay.id === "score-home" ? "home" : "away";

    const teamEvents = scoreEvents
      .filter((e) => e.team === team)
      .sort((a, b) => a.time - b.time);

    // Compute score at overlay start (sum all deltas up to startTime)
    let score = 0;
    for (const ev of teamEvents) {
      if (ev.time > overlay.startTime) break;
      score += ev.delta;
    }

    // Build one overlay per score-change interval
    let segStart = overlay.startTime;
    let segIdx = 0;

    for (const ev of teamEvents) {
      if (ev.time <= overlay.startTime) continue;
      if (ev.time > overlay.endTime) break;

      if (ev.time > segStart) {
        result.push({
          ...overlay,
          id: `${overlay.id}-seg${segIdx}`,
          startTime: segStart,
          endTime: ev.time,
          text: String(Math.max(0, score)),
          dynamic: undefined,
        });
        segIdx++;
      }

      score += ev.delta;
      segStart = ev.time;
    }

    // Final segment
    if (segStart < overlay.endTime) {
      result.push({
        ...overlay,
        id: `${overlay.id}-seg${segIdx}`,
        startTime: segStart,
        endTime: overlay.endTime,
        text: String(Math.max(0, score)),
        dynamic: undefined,
      });
    }
  }

  return result;
}

function buildExportConfig(
  videoPath: string,
  clips: ClipRange[],
  outputPath: string,
  options?: ExportOptions,
): ExportConfig {
  logExportEvent("ExportService", "buildExportConfig");
  const videoState = useVideoStore.getState();
  const appState = useAppStore.getState();
  const qualityProfile = appState.exportQualityProfile;

  const scoreEvents = deriveScoreEvents(
    appState.plays,
    appState.opponentScoreEvents,
    appState.homeScoreEvents,
  );

  const rawOverlays = videoState.showScoreboardOverlay
    ? videoState.overlays
    : [];
  const resolvedOverlays = resolveOverlays(rawOverlays, scoreEvents);
  logExportInputComplexity(clips, resolvedOverlays);
  const sourceWidth = videoState.videoWidth || 1920;
  const sourceHeight = videoState.videoHeight || 1080;
  const fastDimensions = buildFastExportDimensions(sourceWidth, sourceHeight);
  const exportDimensions = usesFastExportDimensions(qualityProfile)
    ? fastDimensions
    : { width: sourceWidth, height: sourceHeight };
  logExportEvent(
    "ExportService",
    `output.qualityProfile profile=${qualityProfile} source=${sourceWidth}x${sourceHeight} export=${exportDimensions.width}x${exportDimensions.height} fps=30`,
  );

  return {
    videoPath,
    clips: [...clips].sort((a, b) => a.start_time - b.start_time),
    overlays: resolvedOverlays,
    outputPath,
    exportWidth: exportDimensions.width,
    exportHeight: exportDimensions.height,
    fps: 30,
    qualityProfile,
    onProgress: options?.onProgress
      ? (pct, status) => options.onProgress!({ percent: pct, status })
      : undefined,
    onProcessChange: options?.onProcessChange,
  };
}

export class ExportService {
  static async cancelActiveExport(): Promise<boolean> {
    return cancelActiveFfmpeg();
  }

  static async ensureExportsDir(): Promise<string> {
    return invoke<string>("ensure_exports_dir");
  }

  static async exportFull(
    videoPath: string,
    clips: ClipRange[],
    outputPath: string,
    options?: ExportOptions
  ): Promise<ExportSummary> {
    logExportEvent("ExportService", "exportFull called");
    await logFfmpegDiagnosticsOnce();
    if (!outputPath) {
      throw new Error("An output path is required for export");
    }

    const videoState = useVideoStore.getState();
    if (!videoState.videoSrc) {
      throw new Error("No video loaded");
    }

    const config = buildExportConfig(videoPath, clips, outputPath, options);
    const result = await runExport(config);
    return attachOutputStats(result);
  }

  static async exportHighlights(
    videoPath: string,
    clips: ClipRange[],
    outputPath: string,
    options?: ExportOptions
  ): Promise<ExportSummary> {
    logExportEvent("ExportService", "exportHighlights called");
    await logFfmpegDiagnosticsOnce();
    if (!outputPath) {
      throw new Error("An output path is required for highlight export");
    }

    const videoState = useVideoStore.getState();
    if (!videoState.videoSrc) {
      throw new Error("No video loaded");
    }

    const config = buildExportConfig(videoPath, clips, outputPath, options);
    const result = await runExport(config);
    return attachOutputStats(result);
  }
}
