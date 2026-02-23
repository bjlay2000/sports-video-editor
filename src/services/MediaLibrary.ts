import { convertFileSrc } from "@tauri-apps/api/core";
import { useVideoStore } from "../store/videoStore";
import { useTimelineStore } from "../store/timelineStore";
import { MediaProcessingService, type TimelineAssets } from "./MediaProcessingService";
import { ThumbnailCaptureService } from "./ThumbnailCaptureService";
import {
  createCancelToken,
  cancelFfmpegToken,
  type FfmpegCancelToken,
} from "./FfmpegService";

const SUPPORTED_EXTENSIONS = [".mp4", ".mov", ".mkv"];

const clipId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

export class MediaLibrary {
  /** Cancel token for the currently running background generation. */
  private static activeCancelToken: FfmpegCancelToken | null = null;

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
      timeline.setThumbnailsGenerating(false);
    } else {
      timeline.setTimelineAssets({ thumbnails: [], waveformSrc: null });
      timeline.setAssetsLoading(false);
      timeline.setThumbnailsGenerating(false);
    }
  }

  /**
   * Non-blocking hydration: the timeline is immediately interactive once
   * duration is known.  Thumbnails & waveform are generated in the background
   * and streamed progressively to the timeline store.
   *
   * If a new clip is loaded while generation is running, the previous
   * generation is cancelled via its cancel token.
   */
  static async hydrateActiveClip(videoElement: HTMLVideoElement, duration: number) {
    const videoState = useVideoStore.getState();
    const timeline = useTimelineStore.getState();
    const activeClipId = videoState.activeClipId;
    const videoPath = videoState.videoPath;
    if (!activeClipId || !videoPath) return;

    videoState.setDuration(duration);
    videoState.updateClip(activeClipId, { duration });

    // ── Fast path: assets already cached ──
    const existingClip = videoState.clips.find((clip) => clip.id === activeClipId);
    const existingAssets = existingClip?.assets;
    if (existingAssets && (existingAssets.thumbnails.length > 0 || Boolean(existingAssets.waveformSrc))) {
      timeline.setTimelineAssets({
        thumbnails: existingAssets.thumbnails,
        waveformSrc: existingAssets.waveformSrc,
      });
      timeline.setAssetsLoading(false);
      timeline.setThumbnailsGenerating(false);
      return;
    }

    // ── Non-blocking: timeline is interactive immediately ──
    timeline.setAssetsLoading(false);
    timeline.setThumbnailsGenerating(true);

    // Cancel any previous in-flight generation
    if (MediaLibrary.activeCancelToken) {
      cancelFfmpegToken(MediaLibrary.activeCancelToken);
    }
    const cancelToken = createCancelToken();
    MediaLibrary.activeCancelToken = cancelToken;

    const generationClipId = activeClipId;

    /** Check whether this generation is still relevant. */
    const isStale = () =>
      cancelToken.cancelled ||
      useVideoStore.getState().activeClipId !== generationClipId;

    const applyAssets = (assets: TimelineAssets) => {
      if (isStale()) return false;
      useVideoStore.getState().updateClip(generationClipId, {
        thumbnail: assets.poster ?? assets.thumbnails[0]?.src ?? undefined,
        assets: {
          thumbnails: assets.thumbnails,
          waveformSrc: assets.waveformSrc,
        },
      });
      useTimelineStore.getState().setTimelineAssets({
        thumbnails: assets.thumbnails,
        waveformSrc: assets.waveformSrc,
      });
      return true;
    };

    let assetsApplied = false;

    // ── Background generation with progressive streaming ──
    try {
      const assets = await MediaProcessingService.generateTimelineAssets(
        videoPath,
        duration,
        {
          cancelToken,
          onThumbnailsUpdate: (thumbs) => {
            if (isStale()) return;
            useTimelineStore.getState().setThumbnails(thumbs);
          },
          onWaveform: (src) => {
            if (isStale()) return;
            const current = useTimelineStore.getState();
            current.setTimelineAssets({
              thumbnails: current.thumbnails,
              waveformSrc: src,
            });
          },
        },
      );

      assetsApplied = applyAssets(assets);
    } catch (err) {
      if (!isStale()) {
        console.warn("FFmpeg thumbnail generation failed, attempting fallback", err);
      }
    }

    // ── Canvas-based fallback if ffmpeg failed ──
    if (!assetsApplied && !isStale()) {
      try {
        const thumbnails = await ThumbnailCaptureService.captureFromVideo(
          videoElement,
          duration,
        );
        if (thumbnails.length > 0) {
          const fallbackAssets: TimelineAssets = {
            thumbnails,
            waveformSrc: null,
            poster: thumbnails[0]?.src,
          };
          applyAssets(fallbackAssets);
        }
      } catch (fallbackErr) {
        console.error("Failed to capture inline thumbnails", fallbackErr);
      }
    }

    // ── Cleanup ──
    if (!isStale()) {
      useTimelineStore.getState().setThumbnailsGenerating(false);
    }
    if (MediaLibrary.activeCancelToken === cancelToken) {
      MediaLibrary.activeCancelToken = null;
    }
  }
}
