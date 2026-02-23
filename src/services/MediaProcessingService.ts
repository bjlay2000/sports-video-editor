import { exists, mkdir, readDir, remove } from "@tauri-apps/plugin-fs";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { TimelineThumbnail } from "../store/timelineStore";
import { runFfmpeg, spawnFfmpeg, type FfmpegCancelToken } from "./FfmpegService";

export interface TimelineAssets {
  thumbnails: TimelineThumbnail[];
  waveformSrc: string | null;
  poster?: string | null;
}

/** Callbacks for progressive / non-blocking asset generation. */
export interface GenerationCallbacks {
  /** Called with the *complete* set of thumbnails found so far (not just new ones). */
  onThumbnailsUpdate?: (thumbnails: TimelineThumbnail[]) => void;
  /** Called once when the waveform image is ready. */
  onWaveform?: (src: string) => void;
  /** Cancel token – when cancelled, generation stops ASAP. */
  cancelToken?: FfmpegCancelToken;
}

const sanitizeSegment = (input: string) =>
  input.replace(/[^a-z0-9]/gi, "_").toLowerCase();

async function ensureDir(path: string) {
  if (!(await exists(path))) {
    await mkdir(path, { recursive: true });
  }
}

async function resetDir(path: string) {
  if (await exists(path)) {
    await remove(path, { recursive: true });
  }
  await mkdir(path, { recursive: true });
}

export class MediaProcessingService {
  /**
   * Generate timeline thumbnails + waveform for a video clip.
   *
   * Improvements over the previous implementation:
   * - Thumbnails & waveform run **concurrently** (not sequentially).
   * - Thumbnails use **keyframe-only** decoding (`-skip_frame nokey`) —
   *   10–50× faster on 4K footage because only I-frames are decoded.
   * - While ffmpeg is running a **polling loop** picks up thumbnails as
   *   they are written to disk and streams them to the caller via
   *   `onThumbnailsUpdate`, giving progressive display.
   * - A `cancelToken` allows aborting mid-generation when the user loads
   *   a different clip.
   */
  static async generateTimelineAssets(
    videoPath: string,
    duration: number,
    callbacks?: GenerationCallbacks,
  ): Promise<TimelineAssets> {
    const cacheRoot = await appCacheDir();
    const previewsRoot = await join(cacheRoot, "sve-previews");
    await ensureDir(previewsRoot);

    const clipFolder = await join(previewsRoot, sanitizeSegment(videoPath));
    await resetDir(clipFolder);

    const token = callbacks?.cancelToken;

    // Run thumbnails and waveform concurrently
    const [thumbResult, waveformResult] = await Promise.allSettled([
      this.generateThumbnailsProgressive(videoPath, duration, clipFolder, callbacks),
      this.generateWaveform(videoPath, clipFolder, callbacks),
    ]);

    if (token?.cancelled) throw new Error("Generation cancelled");

    const thumbnails =
      thumbResult.status === "fulfilled" ? thumbResult.value : [];
    const waveformSrc =
      waveformResult.status === "fulfilled" ? waveformResult.value : null;

    if (thumbResult.status === "rejected" && !token?.cancelled) {
      console.warn("Thumbnail generation failed:", thumbResult.reason);
    }
    if (waveformResult.status === "rejected" && !token?.cancelled) {
      console.warn("Waveform generation failed:", waveformResult.reason);
    }

    return {
      thumbnails,
      waveformSrc,
      poster: thumbnails[0]?.src,
    };
  }

  /* ── Thumbnails (progressive, keyframe-only) ── */

  private static async generateThumbnailsProgressive(
    videoPath: string,
    duration: number,
    clipFolder: string,
    callbacks?: GenerationCallbacks,
  ): Promise<TimelineThumbnail[]> {
    const token = callbacks?.cancelToken;
    if (token?.cancelled) throw new Error("Generation cancelled");

    // Target ~1 thumb per 4 seconds, capped at 30 total.
    // For a 2-minute clip → 30 thumbs.  For a 30s clip → 8 thumbs.
    // This is drastically more efficient than 1/sec or 1/2sec on 4K footage.
    const thumbnailTarget = Math.min(30, Math.max(8, Math.round(duration / 4)));
    const fps = duration > 0 ? thumbnailTarget / duration : 1;
    const thumbPattern = await join(clipFolder, "thumb_%04d.jpg");

    const thumbArgs = [
      "-y",
      "-skip_frame", "nokey",          // only decode I-frames (huge speedup on 4K)
      "-an",                            // skip audio — not needed for thumbnails
      "-i", videoPath,
      "-vf", `fps=${fps.toFixed(4)},scale=160:-1`,   // 160px wide is plenty for timeline strips
      "-vsync", "vfr",                 // variable frame-rate to match keyframe timing
      "-qscale:v", "5",                // lower quality = faster writes, fine for tiny timeline thumbs
      thumbPattern,
    ];

    // Spawn ffmpeg and poll for thumbnails as they are written to disk
    const handle = await spawnFfmpeg(thumbArgs, token);

    let lastEmittedCount = 0;
    let pollActive = true;

    const poll = async () => {
      while (pollActive && !token?.cancelled) {
        await new Promise((r) => setTimeout(r, 400));
        if (!pollActive || token?.cancelled) break;
        try {
          const thumbs = await this.scanAllThumbnails(clipFolder, duration);
          if (thumbs.length > lastEmittedCount) {
            lastEmittedCount = thumbs.length;
            callbacks?.onThumbnailsUpdate?.(thumbs);
          }
        } catch {
          // Directory might not be ready yet or read error — ignore
        }
      }
    };

    const pollPromise = poll();

    try {
      await handle.done;
    } finally {
      pollActive = false;
      await pollPromise;
    }

    // Final sweep to ensure every thumbnail is captured
    const allThumbs = await this.scanAllThumbnails(clipFolder, duration);

    // Emit final complete set if anything new since last poll
    if (allThumbs.length > lastEmittedCount) {
      callbacks?.onThumbnailsUpdate?.(allThumbs);
    }

    return allThumbs;
  }

  /* ── Waveform ── */

  private static async generateWaveform(
    videoPath: string,
    clipFolder: string,
    callbacks?: GenerationCallbacks,
  ): Promise<string | null> {
    const token = callbacks?.cancelToken;
    if (token?.cancelled) return null;

    const waveformPath = await join(clipFolder, "waveform.png");
    const waveformArgs = [
      "-y",
      "-i", videoPath,
      "-filter_complex",
      "aformat=channel_layouts=mono,showwavespic=s=1800x200",
      "-frames:v", "1",
      waveformPath,
    ];

    try {
      const handle = await spawnFfmpeg(waveformArgs, token);
      await handle.done;
    } catch (err) {
      if (token?.cancelled) return null;
      console.warn("Waveform generation failed:", err);
      return null;
    }

    if (await exists(waveformPath)) {
      const src = convertFileSrc(waveformPath);
      callbacks?.onWaveform?.(src);
      return src;
    }
    return null;
  }

  /* ── Helpers ── */

  private static async scanAllThumbnails(
    clipFolder: string,
    duration: number,
  ): Promise<TimelineThumbnail[]> {
    const entries = await readDir(clipFolder);
    const thumbEntries = entries
      .filter((e) => e.name.startsWith("thumb_") && e.name.endsWith(".jpg"))
      .sort((a, b) => a.name.localeCompare(b.name));

    const interval = duration / Math.max(thumbEntries.length, 1);
    const thumbs: TimelineThumbnail[] = [];
    for (let i = 0; i < thumbEntries.length; i++) {
      const filePath = await join(clipFolder, thumbEntries[i].name);
      thumbs.push({
        time: Math.min(duration, i * interval),
        src: convertFileSrc(filePath),
      });
    }
    return thumbs;
  }
}
