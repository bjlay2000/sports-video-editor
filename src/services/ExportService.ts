import { invoke } from "@tauri-apps/api/core";
import { ClipRange } from "../store/types";
import { runFfmpeg, type FfmpegProgressPayload } from "./FfmpegService";
import { createOverlayCompositeFile } from "./OverlayExportService";

interface ExportProgressUpdate {
  percent: number;
  status?: string;
}

interface ExportOptions {
  onProgress?: (update: ExportProgressUpdate) => void;
}

const createProgressHandler = (
  clips: ClipRange[],
  cb?: (update: ExportProgressUpdate) => void
) => {
  if (!cb) return undefined;
  const totalSeconds = clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.end_time - clip.start_time),
    0
  );
  const totalMicros = Math.max(totalSeconds, 0.0001) * 1_000_000;
  let lastPercent = 0;

  return (payload: FfmpegProgressPayload) => {
    if (payload.key === "out_time_ms") {
      const micros = Number(payload.value);
      if (!Number.isFinite(micros)) return;
      const percent = Math.max(0, Math.min(100, (micros / totalMicros) * 100));
      lastPercent = percent;
      cb({
        percent,
        status: `Encoding ${(micros / 1_000_000).toFixed(1)}s of ${totalSeconds.toFixed(1)}s`,
      });
      return;
    }
    if (payload.key === "progress" && payload.value === "end") {
      cb({ percent: 100, status: "Finalizing export..." });
      return;
    }
    if (payload.key === "frame") {
      cb({ percent: lastPercent, status: `Frame ${payload.value}` });
    }
  };
};

export class ExportService {
  static async ensureExportsDir(): Promise<string> {
    return invoke<string>("ensure_exports_dir");
  }

  static async generateFfmpegArgs(
    videoPath: string,
    clips: ClipRange[],
    outputPath: string,
    overlayPath?: string | null
  ): Promise<string[]> {
    return invoke<string[]>("generate_ffmpeg_concat", {
      videoPath,
      clips,
      outputPath,
      overlayPath: overlayPath ?? null,
    });
  }

  static async exportFull(
    videoPath: string,
    clips: ClipRange[],
    outputPath: string,
    options?: ExportOptions
  ): Promise<string> {
    if (!outputPath) {
      throw new Error("An output path is required for export");
    }
    const sortedClips = [...clips].sort((a, b) => a.start_time - b.start_time);
    const overlayAsset = await createOverlayCompositeFile();
    try {
      const args = await this.generateFfmpegArgs(
        videoPath,
        sortedClips,
        outputPath,
        overlayAsset?.path
      );

      options?.onProgress?.({ percent: 0, status: "Preparing export..." });
      await runFfmpeg(args, {
        onProgress: createProgressHandler(sortedClips, options?.onProgress),
      });
    } finally {
      await overlayAsset?.cleanup();
    }

    return outputPath;
  }

  static async exportHighlights(
    videoPath: string,
    clips: ClipRange[],
    statTypes: string[],
    options?: ExportOptions
  ): Promise<string> {
    const exportDir = await this.ensureExportsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const typesLabel = statTypes.join("_");
    const outputPath = `${exportDir}\\highlights_${typesLabel}_${timestamp}.mp4`;

    const sortedClips = [...clips].sort((a, b) => a.start_time - b.start_time);
    const overlayAsset = await createOverlayCompositeFile();
    try {
      const args = await this.generateFfmpegArgs(
        videoPath,
        sortedClips,
        outputPath,
        overlayAsset?.path
      );

      options?.onProgress?.({ percent: 0, status: "Preparing highlights..." });
      await runFfmpeg(args, {
        onProgress: createProgressHandler(sortedClips, options?.onProgress),
      });
    } finally {
      await overlayAsset?.cleanup();
    }

    return outputPath;
  }
}
