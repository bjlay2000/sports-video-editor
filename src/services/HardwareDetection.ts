/**
 * GPU vendor detection and encoder capability discovery.
 *
 * Runs `ffmpeg -encoders` once, parses available hardware encoders,
 * identifies the GPU vendor (NVIDIA / Intel / AMD / CPU-only),
 * and exposes the full encoder priority matrix.
 *
 * ZERO UI/store imports.
 */

import { runFfmpeg } from "./FfmpegService";
import { logExportEvent } from "./ExportLogService";

/* ================================================================
 *  Types
 * ================================================================ */

export type GpuVendor = "nvidia" | "intel" | "amd" | "cpu";

/** Individual hardware encoder we may use. */
export type HwEncoder =
  | "av1_nvenc"
  | "hevc_nvenc"
  | "h264_nvenc"
  | "av1_qsv"
  | "hevc_qsv"
  | "h264_qsv"
  | "hevc_amf"
  | "h264_amf";

/** CPU-only software encoders. */
export type SwEncoder = "libx264" | "libx265";

export type EncoderName = HwEncoder | SwEncoder;

/** Quality profile the user selects in the UI. */
export type QualityProfile =
  | "ultraFast"  // Ultra Fast (Larger File) – max speed
  | "fast"       // Fast Export (Recommended) – speed first
  | "high"       // High Quality – balanced
  | "maximum"    // Maximum Quality – quality first
  | "small";     // Small File Size – compression first

export type ExportQualityContext = "highlights" | "full";

/** Full set of detected encoder capabilities. */
export interface EncoderCapabilities {
  vendor: GpuVendor;
  availableHw: HwEncoder[];
  availableSw: SwEncoder[];
  /** The best encoder chain ordered by priority for this vendor. */
  priorityChain: EncoderName[];
  /** Raw ffmpeg -encoders output (for diagnostics). */
  rawOutput: string;
}

/** Resolved encoder + ffmpeg args ready for use. */
export interface ResolvedEncoder {
  name: EncoderName;
  vendor: GpuVendor;
  codecArgs: string[];
  hwaccelArgs: string[];
}

/* ================================================================
 *  Preset Intents — the single source of truth for what each
 *  quality preset *means* in hardware-neutral terms.
 *
 *  Hardware-specific mapping tables translate these intents into
 *  concrete encoder args.  Separating intent from implementation
 *  keeps cross-vendor quality consistent.
 * ================================================================ */

export interface PresetIntent {
  speedBias: number;        // 0–10  (10 = fastest)
  compressionBias: number;  // 0–10  (10 = best compression)
  targetQuality: number;    // normalised 0–100
  lookahead: boolean;
}

export const PRESET_INTENTS: Record<QualityProfile, PresetIntent> = {
  ultraFast: { speedBias: 10, compressionBias: 2,  targetQuality: 72, lookahead: false },
  fast:      { speedBias: 8,  compressionBias: 6,  targetQuality: 78, lookahead: false },
  high:      { speedBias: 6,  compressionBias: 8,  targetQuality: 84, lookahead: false },
  maximum:   { speedBias: 3,  compressionBias: 10, targetQuality: 90, lookahead: true  },
  small:     { speedBias: 7,  compressionBias: 9,  targetQuality: 70, lookahead: false },
};

interface QualityPresetConfig {
  label: string;
  defaultForHighlights: boolean;
  defaultForFull: boolean;
  useFastDimensions: boolean;
  qsv: {
    codec: "h264" | "hevc";
    preset: string;
    quality: string;
    lookAhead: boolean;
  };
  nvenc: {
    codec: "h264" | "hevc";
    preset: string;
    quality: string;
    lookAhead: boolean;
  };
  amf: {
    codec: "h264" | "hevc";
    qualityMode: "speed" | "balanced" | "quality";
    qp: string;
  };
  cpu: {
    codec: "h264" | "hevc";
    preset: string;
    crf: string;
  };
}

export const QUALITY_PRESETS: Record<QualityProfile, QualityPresetConfig> = {
  ultraFast: {
    label: "Ultra Fast (Larger File)",
    defaultForHighlights: false,
    defaultForFull: false,
    useFastDimensions: true,
    qsv:   { codec: "h264", preset: "7",  quality: "23", lookAhead: false },
    nvenc: { codec: "h264", preset: "p7", quality: "23", lookAhead: false },
    amf:   { codec: "h264", qualityMode: "speed",    qp: "23" },
    cpu:   { codec: "h264", preset: "veryfast", crf: "23" },
  },
  fast: {
    label: "Fast Export (Recommended)",
    defaultForHighlights: true,
    defaultForFull: true,
    useFastDimensions: true,
    qsv:   { codec: "hevc", preset: "7",  quality: "22", lookAhead: false },
    nvenc: { codec: "hevc", preset: "p6", quality: "22", lookAhead: false },
    amf:   { codec: "hevc", qualityMode: "speed",    qp: "22" },
    cpu:   { codec: "hevc", preset: "medium",   crf: "22" },
  },
  high: {
    label: "High Quality",
    defaultForHighlights: false,
    defaultForFull: false,
    useFastDimensions: false,
    qsv:   { codec: "hevc", preset: "6",  quality: "20", lookAhead: false },
    nvenc: { codec: "hevc", preset: "p5", quality: "20", lookAhead: false },
    amf:   { codec: "hevc", qualityMode: "balanced", qp: "20" },
    cpu:   { codec: "hevc", preset: "slow",     crf: "20" },
  },
  maximum: {
    label: "Maximum Quality",
    defaultForHighlights: false,
    defaultForFull: false,
    useFastDimensions: false,
    qsv:   { codec: "hevc", preset: "4",  quality: "18", lookAhead: true  },
    nvenc: { codec: "hevc", preset: "p3", quality: "18", lookAhead: true  },
    amf:   { codec: "hevc", qualityMode: "quality",  qp: "18" },
    cpu:   { codec: "hevc", preset: "slower",   crf: "18" },
  },
  small: {
    label: "Small File Size",
    defaultForHighlights: false,
    defaultForFull: false,
    useFastDimensions: false,
    qsv:   { codec: "hevc", preset: "7",  quality: "26", lookAhead: false },
    nvenc: { codec: "hevc", preset: "p6", quality: "26", lookAhead: false },
    amf:   { codec: "hevc", qualityMode: "balanced", qp: "26" },
    cpu:   { codec: "hevc", preset: "medium",   crf: "26" },
  },
};

export const QUALITY_PROFILE_OPTIONS: QualityProfile[] = [
  "ultraFast",
  "fast",
  "high",
  "maximum",
  "small",
];

export const QUALITY_PROFILE_LABELS: Record<QualityProfile, string> =
  QUALITY_PROFILE_OPTIONS.reduce((acc, profile) => {
    acc[profile] = QUALITY_PRESETS[profile].label;
    return acc;
  }, {} as Record<QualityProfile, string>);

export function defaultQualityForContext(context: ExportQualityContext): QualityProfile {
  for (const profile of QUALITY_PROFILE_OPTIONS) {
    const preset = QUALITY_PRESETS[profile];
    if ((context === "highlights" && preset.defaultForHighlights) || (context === "full" && preset.defaultForFull)) {
      return profile;
    }
  }
  return "fast";
}

export function usesFastExportDimensions(profile: QualityProfile): boolean {
  return QUALITY_PRESETS[profile].useFastDimensions;
}

/* ================================================================
 *  Hwaccel decode args per encoder
 *
 *  QSV path uses explicit hardware frames:
 *    -hwaccel qsv -hwaccel_output_format qsv
 *
 *  Other hardware encoders keep auto hwaccel selection.
 *  CPU-only gets no hwaccel args.
 * ================================================================ */

function hwaccelArgsForEncoder(encoder: EncoderName): string[] {
  if (encoder.endsWith("_qsv")) {
    return ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"];
  }
  if (encoder.endsWith("_nvenc") || encoder.endsWith("_amf")) {
    return ["-hwaccel", "auto"];
  }
  return [];
}

/* ================================================================
 *  Encoder priority chains per vendor
 * ================================================================ */

const VENDOR_PRIORITY: Record<GpuVendor, EncoderName[]> = {
  nvidia: ["av1_nvenc", "hevc_nvenc", "h264_nvenc", "libx265", "libx264"],
  intel:  ["av1_qsv",  "hevc_qsv",  "h264_qsv",  "libx265", "libx264"],
  amd:    ["hevc_amf", "h264_amf",  "libx265", "libx264"],
  cpu:    ["libx265", "libx264"],
};

/* ================================================================
 *  Hardware abstraction and preset → encoder settings mapping
 * ================================================================ */

function firstAvailableEncoder(
  preferred: EncoderName[],
  availableHw: HwEncoder[],
  availableSw: SwEncoder[],
): EncoderName {
  for (const encoder of preferred) {
    if (availableHw.includes(encoder as HwEncoder) || availableSw.includes(encoder as SwEncoder)) {
      return encoder;
    }
  }
  return "libx264";
}

function pickEncoderForPreset(
  preset: QualityProfile,
  hardwareType: GpuVendor,
  availableHw: HwEncoder[],
  availableSw: SwEncoder[],
): EncoderName {
  const isUltraFast = preset === "ultraFast";

  if (hardwareType === "intel") {
    return firstAvailableEncoder(
      isUltraFast
        ? ["h264_qsv", "hevc_qsv", "libx264"]
        : ["hevc_qsv", "h264_qsv", "libx264"],
      availableHw,
      availableSw,
    );
  }

  if (hardwareType === "nvidia") {
    return firstAvailableEncoder(
      isUltraFast
        ? ["h264_nvenc", "hevc_nvenc", "libx264"]
        : ["hevc_nvenc", "h264_nvenc", "libx265", "libx264"],
      availableHw,
      availableSw,
    );
  }

  if (hardwareType === "amd") {
    return firstAvailableEncoder(
      isUltraFast
        ? ["h264_amf", "hevc_amf", "libx264"]
        : ["hevc_amf", "h264_amf", "libx265", "libx264"],
      availableHw,
      availableSw,
    );
  }

  // CPU: prefer the codec specified in the preset config
  const cpuCodecPref = QUALITY_PRESETS[preset].cpu.codec;
  return firstAvailableEncoder(
    cpuCodecPref === "hevc"
      ? ["libx265", "libx264"]
      : ["libx264", "libx265"],
    availableHw,
    availableSw,
  );
}

/* ================================================================
 *  buildCodecArgs — produces encoder args from centralized presets
 * ================================================================ */

export function buildCodecArgs(encoder: EncoderName, profile: QualityProfile): string[] {
  const preset = QUALITY_PRESETS[profile];
  const args: string[] = ["-c:v", encoder];

  if (encoder.endsWith("_qsv")) {
    args.push(
      "-preset", preset.qsv.preset,
      "-global_quality", preset.qsv.quality,
      "-look_ahead", preset.qsv.lookAhead ? "1" : "0",
    );
    if (encoder.startsWith("h264")) {
      args.push("-profile:v", "high");
    }
    if (encoder.startsWith("hevc")) {
      args.push("-profile:v", "main", "-tag:v", "hvc1");
    }
    return args;
  }

  if (encoder.endsWith("_nvenc")) {
    args.push(
      "-preset", preset.nvenc.preset,
      "-cq", preset.nvenc.quality,
      "-rc", "vbr",
    );
    if (preset.nvenc.lookAhead) {
      args.push("-rc-lookahead", "20");
    }
    if (encoder.startsWith("h264")) {
      args.push("-profile:v", "high");
    }
    if (encoder.startsWith("hevc")) {
      args.push("-profile:v", "main", "-tag:v", "hvc1");
    }
    return args;
  }

  if (encoder.endsWith("_amf")) {
    args.push(
      "-quality", preset.amf.qualityMode,
      "-rc", "cqp",
      "-qp_i", preset.amf.qp,
      "-qp_p", preset.amf.qp,
    );
    if (encoder.startsWith("hevc")) {
      args.push("-tag:v", "hvc1");
    }
    return args;
  }

  // CPU fallback
  args.push("-preset", preset.cpu.preset, "-crf", preset.cpu.crf, "-threads", "0");
  if (encoder === "libx264") {
    args.push("-profile:v", "high");
  }
  if (encoder === "libx265") {
    args.push("-tag:v", "hvc1");
  }
  return args;
}

export function resolveEncoderSettings(
  qualityPreset: QualityProfile,
  hardwareType: GpuVendor,
  capabilities?: Pick<EncoderCapabilities, "availableHw" | "availableSw">,
): { encoder: EncoderName; codecArgs: string[] } {
  const availableHw = capabilities?.availableHw ?? [];
  const availableSw = capabilities?.availableSw ?? ["libx264"];
  const encoder = pickEncoderForPreset(qualityPreset, hardwareType, availableHw, availableSw);
  const codecArgs = buildCodecArgs(encoder, qualityPreset);
  return { encoder, codecArgs };
}

/* ================================================================
 *  Detection — runs `ffmpeg -encoders` and parses output
 * ================================================================ */

const HW_ENCODER_PATTERNS: Record<HwEncoder, RegExp> = {
  av1_nvenc:  /^\s*V.{5}\s+av1_nvenc\b/m,
  hevc_nvenc: /^\s*V.{5}\s+hevc_nvenc\b/m,
  h264_nvenc: /^\s*V.{5}\s+h264_nvenc\b/m,
  av1_qsv:   /^\s*V.{5}\s+av1_qsv\b/m,
  hevc_qsv:  /^\s*V.{5}\s+hevc_qsv\b/m,
  h264_qsv:  /^\s*V.{5}\s+h264_qsv\b/m,
  hevc_amf:  /^\s*V.{5}\s+hevc_amf\b/m,
  h264_amf:  /^\s*V.{5}\s+h264_amf\b/m,
};

const SW_ENCODER_PATTERNS: Record<SwEncoder, RegExp> = {
  libx264: /^\s*V.{5}\s+libx264\b/m,
  libx265: /^\s*V.{5}\s+libx265\b/m,
};

/* ================================================================
 *  Probe — actually test-encode one frame to verify HW is present
 *
 *  `ffmpeg -encoders` only tells us what ffmpeg was COMPILED with,
 *  not what GPU hardware is actually installed.  A full-feature
 *  build (like gyan.dev) lists nvenc, qsv, AND amf regardless.
 *  We must try a real encode to know if the hardware is there.
 * ================================================================ */

async function probeEncoder(codec: string): Promise<boolean> {
  logExportEvent("HardwareDetection", `probing ${codec}...`);
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.04",
      "-frames:v", "1",
      "-c:v", codec,
      "-f", "null", "-",
    ]);
    logExportEvent("HardwareDetection", `probe ${codec}: OK`);
    return true;
  } catch {
    logExportEvent("HardwareDetection", `probe ${codec}: FAILED (no hardware)`);
    return false;
  }
}

/**
 * Determine which vendor family an encoder name belongs to.
 */
function vendorOfEncoder(name: EncoderName): GpuVendor {
  if (name.endsWith("_nvenc")) return "nvidia";
  if (name.endsWith("_qsv"))  return "intel";
  if (name.endsWith("_amf"))  return "amd";
  return "cpu";
}

let cachedCapabilities: Promise<EncoderCapabilities> | null = null;

/**
 * Detect available encoders.
 *
 * 1. Parse `ffmpeg -encoders` to get compiled-in candidates (fast).
 * 2. Group HW candidates by vendor family.
 * 3. Probe ONE encoder per vendor family (cheapest H.264 variant).
 *    If the probe fails the entire vendor family is removed —
 *    the hardware simply isn't present.
 * 4. Build the final priority chain from verified encoders + CPU.
 *
 * Results are cached for the lifetime of the process.
 */
export async function detectHardwareEncoders(): Promise<EncoderCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;

  cachedCapabilities = (async (): Promise<EncoderCapabilities> => {
    logExportEvent("HardwareDetection", "running ffmpeg -encoders");
    let rawOutput = "";
    try {
      rawOutput = await runFfmpeg(["-hide_banner", "-encoders"]);
    } catch (err) {
      logExportEvent("HardwareDetection", `ffmpeg -encoders failed: ${String(err)}`);
      return {
        vendor: "cpu",
        availableHw: [],
        availableSw: ["libx264"],
        priorityChain: ["libx264"],
        rawOutput: "",
      };
    }

    logExportEvent("HardwareDetection", `ffmpeg -encoders output length=${rawOutput.length}`);

    // ── Step 1: parse compiled-in encoders ──
    const compiledHw: HwEncoder[] = [];
    for (const [name, pattern] of Object.entries(HW_ENCODER_PATTERNS) as [HwEncoder, RegExp][]) {
      if (pattern.test(rawOutput)) {
        compiledHw.push(name);
        logExportEvent("HardwareDetection", `compiled-in: ${name}`);
      }
    }

    const availableSw: SwEncoder[] = [];
    for (const [name, pattern] of Object.entries(SW_ENCODER_PATTERNS) as [SwEncoder, RegExp][]) {
      if (pattern.test(rawOutput)) {
        availableSw.push(name);
        logExportEvent("HardwareDetection", `compiled-in: ${name}`);
      }
    }
    if (!availableSw.includes("libx264")) {
      availableSw.push("libx264");
    }

    // ── Step 2: probe one encoder per vendor to verify real hardware ──
    // We probe the cheapest (H.264) variant per family — if H.264 works
    // the AV1/HEVC variants from that vendor will too.
    const vendorProbes: { vendor: GpuVendor; probe: HwEncoder }[] = [
      { vendor: "nvidia", probe: "h264_nvenc" },
      { vendor: "intel",  probe: "h264_qsv" },
      { vendor: "amd",    probe: "h264_amf" },
    ];

    const verifiedVendors = new Set<GpuVendor>();

    for (const { vendor, probe } of vendorProbes) {
      if (!compiledHw.includes(probe)) {
        logExportEvent("HardwareDetection", `${vendor}: ${probe} not compiled in, skipping`);
        continue;
      }
      if (await probeEncoder(probe)) {
        verifiedVendors.add(vendor);
        logExportEvent("HardwareDetection", `${vendor}: hardware VERIFIED via ${probe}`);
      } else {
        logExportEvent("HardwareDetection", `${vendor}: hardware NOT present (${probe} probe failed)`);
      }
    }

    // Keep only HW encoders whose vendor family was verified
    const availableHw = compiledHw.filter((enc) =>
      verifiedVendors.has(vendorOfEncoder(enc)),
    );

    // ── Step 3: pick primary vendor ──
    let vendor: GpuVendor = "cpu";
    if (verifiedVendors.has("nvidia"))      vendor = "nvidia";
    else if (verifiedVendors.has("intel")) vendor = "intel";
    else if (verifiedVendors.has("amd"))   vendor = "amd";

    logExportEvent(
      "HardwareDetection",
      `verified vendor=${vendor} hw=[${availableHw.join(",")}] sw=[${availableSw.join(",")}]`,
    );

    // ── Step 4: build priority chain ──
    const fullChain = VENDOR_PRIORITY[vendor];
    const priorityChain = fullChain.filter((enc) =>
      availableHw.includes(enc as HwEncoder) || availableSw.includes(enc as SwEncoder),
    );
    if (!priorityChain.includes("libx264")) {
      priorityChain.push("libx264");
    }

    logExportEvent("HardwareDetection", `priority chain: [${priorityChain.join(" → ")}]`);

    return {
      vendor,
      availableHw,
      availableSw,
      priorityChain,
      rawOutput,
    };
  })();

  return cachedCapabilities;
}

/**
 * Resolve encoder + args for a given quality preset using detected hardware.
 */
export async function resolveEncoder(profile: QualityProfile): Promise<ResolvedEncoder> {
  const caps = await detectHardwareEncoders();

  const settings = resolveEncoderSettings(profile, caps.vendor, {
    availableHw: caps.availableHw,
    availableSw: caps.availableSw,
  });

  const selected = settings.encoder;
  const selectedVendor = vendorOfEncoder(selected);

  logExportEvent(
    "HardwareDetection",
    `resolved encoder=${selected} for profile=${profile} vendor=${selectedVendor} args=[${settings.codecArgs.join(" ")}]`,
  );

  return {
    name: selected,
    vendor: selectedVendor,
    codecArgs: settings.codecArgs,
    hwaccelArgs: hwaccelArgsForEncoder(selected),
  };
}

/**
 * Clear the cached encoder capabilities.
 * Useful if the user changes GPU drivers or ffmpeg version.
 */
export function clearHardwareCache(): void {
  cachedCapabilities = null;
  logExportEvent("HardwareDetection", "hardware cache cleared");
}

/**
 * Human-readable label for the detected GPU vendor.
 */
export function vendorDisplayName(vendor: GpuVendor): string {
  switch (vendor) {
    case "nvidia": return "NVIDIA (NVENC)";
    case "intel":  return "Intel (QSV)";
    case "amd":    return "AMD (AMF)";
    case "cpu":    return "CPU (Software)";
  }
}

/**
 * Human-readable encoder name for the completion dialog.
 */
export function encoderDisplayName(name: EncoderName): string {
  const map: Record<EncoderName, string> = {
    av1_nvenc:  "AV1 NVENC",
    hevc_nvenc: "HEVC NVENC",
    h264_nvenc: "H.264 NVENC",
    av1_qsv:   "AV1 QSV",
    hevc_qsv:  "HEVC QSV",
    h264_qsv:  "H.264 QSV",
    hevc_amf:  "HEVC AMF",
    h264_amf:  "H.264 AMF",
    libx264:   "H.264 (CPU)",
    libx265:   "H.265 (CPU)",
  };
  return map[name] ?? name;
}
