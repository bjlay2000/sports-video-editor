import { invoke } from "@tauri-apps/api/core";
import { ClipRange } from "../store/types";
import { useVideoStore } from "../store/videoStore";
import { useAppStore } from "../store/appStore";
import { deriveScoreEvents } from "../engine/scoreEvents";
import { exportWithFrames } from "../engine/FrameExporter";
import type { TimelineModel } from "../engine/types";

interface ExportProgressUpdate {
  percent: number;
  status?: string;
}

interface ExportOptions {
  onProgress?: (update: ExportProgressUpdate) => void;
}

function buildTimelineModel(): TimelineModel {
  const videoState = useVideoStore.getState();
  const appState = useAppStore.getState();
  const scoreEvents = deriveScoreEvents(
    appState.plays,
    appState.opponentScoreEvents,
    appState.homeScoreEvents,
  );

  return {
    duration: videoState.duration,
    currentTime: 0,
    overlays: videoState.showScoreboardOverlay ? videoState.overlays : [],
    scoreEvents: videoState.showScoreboardOverlay ? scoreEvents : [],
    videoTrack: { keyframes: videoState.videoTrackKeyframes },
  };
}

export class ExportService {
  static async ensureExportsDir(): Promise<string> {
    return invoke<string>("ensure_exports_dir");
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

    const videoState = useVideoStore.getState();
    if (!videoState.videoSrc) {
      throw new Error("No video loaded");
    }

    const sortedClips = [...clips].sort((a, b) => a.start_time - b.start_time);
    const timelineModel = buildTimelineModel();

    return exportWithFrames({
      videoPath,
      clips: sortedClips,
      timelineModel,
      outputPath,
      width: videoState.videoWidth || 1920,
      height: videoState.videoHeight || 1080,
      onProgress: options?.onProgress
        ? (pct, status) => options.onProgress!({ percent: pct, status })
        : undefined,
    });
  }

  static async exportHighlights(
    videoPath: string,
    clips: ClipRange[],
    outputPath: string,
    options?: ExportOptions
  ): Promise<string> {
    if (!outputPath) {
      throw new Error("An output path is required for highlight export");
    }

    const videoState = useVideoStore.getState();
    if (!videoState.videoSrc) {
      throw new Error("No video loaded");
    }

    const sortedClips = [...clips].sort((a, b) => a.start_time - b.start_time);
    const timelineModel = buildTimelineModel();

    return exportWithFrames({
      videoPath,
      clips: sortedClips,
      timelineModel,
      outputPath,
      width: videoState.videoWidth || 1920,
      height: videoState.videoHeight || 1080,
      onProgress: options?.onProgress
        ? (pct, status) => options.onProgress!({ percent: pct, status })
        : undefined,
    });
  }
}
