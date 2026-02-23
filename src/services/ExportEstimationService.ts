/**
 * Export time estimation with self-learning baselines.
 *
 * Provides pre-export estimated time based on:
 * 1. Hardware performance profiles (baseline fps per codec/resolution)
 * 2. Preset speed multipliers (derived from PresetIntent.speedBias)
 * 3. Rolling average of actual export fps, stored in localStorage
 *
 * ZERO UI/store imports.
 */

import type { QualityProfile, GpuVendor, EncoderName } from "./HardwareDetection";
import { PRESET_INTENTS } from "./HardwareDetection";

/* ================================================================
 *  Hardware performance profiles — baseline encode fps
 *
 *  Keyed by resolution bucket and codec family.
 *  Values are conservative estimates (safe to under-promise).
 * ================================================================ */

export interface HardwarePerfProfile {
  h264_1080p: number;
  hevc_1080p: number;
  h264_4k: number;
  hevc_4k: number;
}

const DEFAULT_BASELINES: Record<GpuVendor, HardwarePerfProfile> = {
  intel: {
    h264_1080p: 40,
    hevc_1080p: 28,
    h264_4k: 28,
    hevc_4k: 20,
  },
  nvidia: {
    h264_1080p: 60,
    hevc_1080p: 45,
    h264_4k: 40,
    hevc_4k: 30,
  },
  amd: {
    h264_1080p: 50,
    hevc_1080p: 35,
    h264_4k: 30,
    hevc_4k: 22,
  },
  cpu: {
    h264_1080p: 18,
    hevc_1080p: 12,
    h264_4k: 6,
    hevc_4k: 4,
  },
};

/* ================================================================
 *  Preset speed multipliers
 *
 *  Applied to the baseline fps to account for encoder effort.
 * ================================================================ */

const PRESET_SPEED_MULTIPLIERS: Record<QualityProfile, number> = {
  ultraFast: 1.15,
  fast:      1.0,
  high:      0.85,
  maximum:   0.7,
  small:     0.95,
};

/* ================================================================
 *  Self-learning rolling average — persisted in localStorage
 * ================================================================ */

const STORAGE_KEY = "sve_export_fps_baselines";
const MAX_SAMPLES = 10;

interface FpsSample {
  fps: number;
  timestamp: number;
}

interface StoredBaselines {
  // key = "vendor:codec:resolution" e.g. "intel:hevc:1080p"
  [key: string]: FpsSample[];
}

function loadStoredBaselines(): StoredBaselines {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredBaselines;
  } catch {
    return {};
  }
}

function saveStoredBaselines(data: StoredBaselines): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or unavailable — silent */
  }
}

/* ================================================================
 *  Resolution bucket helper
 * ================================================================ */

type ResolutionBucket = "1080p" | "4k";

function resolutionBucket(width: number, height: number): ResolutionBucket {
  const pixels = width * height;
  // 4K threshold: anything above 1920×1080 (2_073_600 pixels)
  return pixels > 2_200_000 ? "4k" : "1080p";
}

function codecFamily(encoder: EncoderName): "h264" | "hevc" {
  if (encoder.startsWith("h264") || encoder === "libx264") return "h264";
  return "hevc";
}

function profileKey(
  vendor: GpuVendor,
  codec: "h264" | "hevc",
  res: ResolutionBucket,
): string {
  return `${vendor}:${codec}:${res}`;
}

/* ================================================================
 *  Public API
 * ================================================================ */

/**
 * Estimate export time in seconds for a given configuration.
 *
 * Returns `null` if source dimensions or duration aren't available yet.
 */
export function estimateExportSeconds(params: {
  preset: QualityProfile;
  vendor: GpuVendor;
  encoder: EncoderName;
  totalDurationSec: number;
  exportWidth: number;
  exportHeight: number;
  fps: number;
}): number | null {
  const { preset, vendor, encoder, totalDurationSec, exportWidth, exportHeight, fps } = params;

  if (totalDurationSec <= 0 || exportWidth <= 0 || exportHeight <= 0 || fps <= 0) {
    return null;
  }

  const totalFrames = Math.ceil(totalDurationSec * fps);
  const res = resolutionBucket(exportWidth, exportHeight);
  const codec = codecFamily(encoder);
  const key = profileKey(vendor, codec, res);

  // Try self-learned baseline first
  const stored = loadStoredBaselines();
  let baselineFps: number;

  if (stored[key] && stored[key].length > 0) {
    // Use rolling average of observed fps
    const samples = stored[key];
    baselineFps = samples.reduce((sum, s) => sum + s.fps, 0) / samples.length;
  } else {
    // Fall back to default estimates
    const profile = DEFAULT_BASELINES[vendor];
    const profileKey_ = `${codec}_${res}` as keyof HardwarePerfProfile;
    baselineFps = profile[profileKey_];
  }

  const multiplier = PRESET_SPEED_MULTIPLIERS[preset];
  const estimatedFps = baselineFps * multiplier;
  const exportSeconds = totalFrames / estimatedFps;

  return exportSeconds;
}

/**
 * Format estimated seconds into a user-friendly string.
 *
 * Rounds to nearest 5 seconds.
 * Examples: "~25s", "~2m 30s", "~1h 5m"
 */
export function formatEstimatedTime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  // Round to nearest 5 seconds
  const rounded = Math.round(seconds / 5) * 5;
  const clamped = Math.max(5, rounded); // minimum 5s

  if (clamped < 60) {
    return `~${clamped}s`;
  }

  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;

  if (h > 0) {
    return s > 0 ? `~${h}h ${m}m ${s}s` : `~${h}h ${m}m`;
  }

  return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

/**
 * Record the actual encode fps after an export completes.
 *
 * Updates the rolling average for future estimates.
 */
export function recordActualExportFps(params: {
  vendor: GpuVendor;
  encoder: EncoderName;
  exportWidth: number;
  exportHeight: number;
  actualFps: number;
}): void {
  const { vendor, encoder, exportWidth, exportHeight, actualFps } = params;

  if (!Number.isFinite(actualFps) || actualFps <= 0) return;

  const res = resolutionBucket(exportWidth, exportHeight);
  const codec = codecFamily(encoder);
  const key = profileKey(vendor, codec, res);

  const stored = loadStoredBaselines();
  const samples = stored[key] ?? [];

  samples.push({ fps: actualFps, timestamp: Date.now() });

  // Keep only the most recent MAX_SAMPLES
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }

  stored[key] = samples;
  saveStoredBaselines(stored);
}

/**
 * Get both the raw seconds and formatted string in one call.
 */
export function getExportEstimate(params: {
  preset: QualityProfile;
  vendor: GpuVendor;
  encoder: EncoderName;
  totalDurationSec: number;
  exportWidth: number;
  exportHeight: number;
  fps: number;
}): { seconds: number | null; display: string | null } {
  const seconds = estimateExportSeconds(params);
  const display = formatEstimatedTime(seconds);
  return { seconds, display };
}
