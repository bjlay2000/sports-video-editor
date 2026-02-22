import { convertFileSrc } from "@tauri-apps/api/core";
import { useVideoStore } from "../store/videoStore";
import { useTimelineStore } from "../store/timelineStore";
import { MediaProcessingService, type TimelineAssets } from "./MediaProcessingService";
import { ThumbnailCaptureService } from "./ThumbnailCaptureService";

const SUPPORTED_EXTENSIONS = [".mp4", ".mov", ".mkv"];

const clipId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

export class MediaLibrary {
  static isSupported(path: string) {
    const lower = path.toLowerCase();
    return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  static async loadClipFromPath(path: string) {
    if (!this.isSupported(path)) {
      throw new Error("Unsupported video type. Use mp4, mov, or mkv.");
    }
    const src = convertFileSrc(path);
    const state = useVideoStore.getState();
    const id = clipId();
    state.registerClip({ id, path, name: basename(path), src });
    state.setVideoSrc(src);
    state.setVideoPath(path);
    state.resetTransform();
    useTimelineStore.getState().setTimelineAssets({ thumbnails: [], waveformSrc: null });
  }

  static async activateClip(id: string) {
    const videoState = useVideoStore.getState();
    const clip = videoState.clips.find((c) => c.id === id);
    if (!clip) return;
    videoState.setActiveClip(id);
    videoState.setVideoSrc(clip.src);
    videoState.setVideoPath(clip.path);
    if (clip.duration) {
      videoState.setDuration(clip.duration);
    }
    const timeline = useTimelineStore.getState();
    if (clip.assets) {
      timeline.setTimelineAssets({
        thumbnails: clip.assets.thumbnails,
        waveformSrc: clip.assets.waveformSrc,
      });
      timeline.setAssetsLoading(false);
    } else {
      timeline.setTimelineAssets({ thumbnails: [], waveformSrc: null });
      timeline.setAssetsLoading(true);
    }
  }

  static async hydrateActiveClip(videoElement: HTMLVideoElement, duration: number) {
    const videoState = useVideoStore.getState();
    const timeline = useTimelineStore.getState();
    const activeClipId = videoState.activeClipId;
    const videoPath = videoState.videoPath;
    if (!activeClipId || !videoPath) return;

    videoState.setDuration(duration);
    videoState.updateClip(activeClipId, { duration });

    const existingClip = videoState.clips.find((clip) => clip.id === activeClipId);
    const existingAssets = existingClip?.assets;
    if (existingAssets && (existingAssets.thumbnails.length > 0 || Boolean(existingAssets.waveformSrc))) {
      timeline.setTimelineAssets({
        thumbnails: existingAssets.thumbnails,
        waveformSrc: existingAssets.waveformSrc,
      });
      timeline.setAssetsLoading(false);
      return;
    }

    timeline.setAssetsLoading(true);

    const applyAssets = (assets: TimelineAssets) => {
      if (useVideoStore.getState().activeClipId !== activeClipId) {
        return false;
      }
      videoState.updateClip(activeClipId, {
        thumbnail: assets.poster ?? assets.thumbnails[0]?.src ?? undefined,
        assets: {
          thumbnails: assets.thumbnails,
          waveformSrc: assets.waveformSrc,
        },
      });
      timeline.setTimelineAssets({
        thumbnails: assets.thumbnails,
        waveformSrc: assets.waveformSrc,
      });
      return true;
    };

    let assetsApplied = false;

    try {
      const assets = await MediaProcessingService.generateTimelineAssets(
        videoPath,
        duration
      );
      assetsApplied = applyAssets(assets);
    } catch (err) {
      console.warn("FFmpeg thumbnail generation failed, attempting fallback", err);
    }

    if (!assetsApplied) {
      try {
        const thumbnails = await ThumbnailCaptureService.captureFromVideo(
          videoElement,
          duration
        );
        if (thumbnails.length > 0) {
          const fallbackAssets: TimelineAssets = {
            thumbnails,
            waveformSrc: null,
            poster: thumbnails[0]?.src,
          };
          assetsApplied = applyAssets(fallbackAssets);
        }
      } catch (err) {
        console.error("Failed to capture inline thumbnails", err);
      }
    }

    timeline.setAssetsLoading(false);
  }
}
