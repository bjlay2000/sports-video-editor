import { exists, mkdir, readDir, remove, stat, writeFile, readFile } from "@tauri-apps/plugin-fs";
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

/** Simple hash from path + size + mtime for cache invalidation. */
async function computeVideoHash(videoPath: string): Promise<string> {
  try {
    const info = await stat(videoPath);
    const raw = `${videoPath}|${info.size ?? 0}|${info.mtime?.getTime() ?? 0}`;
    // Use SubtleCrypto SHA-1 when available, else fallback to simple hash
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const data = new TextEncoder().encode(raw);
      const buf = await crypto.subtle.digest("SHA-1", data);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    // Fallback: simple djb2 hash
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  } catch {
    return `fallback-${Date.now()}`;
  }
}

interface CacheMetadata {
  videoHash: string;
  thumbCount: number;
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
    await ensureDir(clipFolder);

    const token = callbacks?.cancelToken;

    // ── Cache check: reuse thumbnails if video hasn't changed ──
    const videoHash = await computeVideoHash(videoPath);
    const metadataPath = await join(clipFolder, "metadata.json");
    let cacheValid = false;
    try {
      if (await exists(metadataPath)) {
        const raw = new TextDecoder().decode(await readFile(metadataPath));
        const meta: CacheMetadata = JSON.parse(raw);
        if (meta.videoHash === videoHash && meta.thumbCount > 0) {
          // Verify thumbnails still exist
          const existing = await this.scanAllThumbnails(clipFolder, duration);
          if (existing.length >= meta.thumbCount) {
            cacheValid = true;
            callbacks?.onThumbnailsUpdate?.(existing);

            // Also check for waveform
            const waveformPath = await join(clipFolder, "waveform.png");
            const waveformSrc = (await exists(waveformPath))
              ? convertFileSrc(waveformPath)
              : null;
            if (waveformSrc) callbacks?.onWaveform?.(waveformSrc);

            return {
              thumbnails: existing,
              waveformSrc,
              poster: existing[0]?.src ?? null,
            };
          }
        }
      }
    } catch {
      // Cache read failed — regenerate
    }

    if (!cacheValid) {
      await resetDir(clipFolder);
    }

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

    // Write cache metadata for reuse on next load
    try {
      const meta: CacheMetadata = { videoHash, thumbCount: thumbnails.length };
      await writeFile(
        metadataPath,
        new TextEncoder().encode(JSON.stringify(meta)),
      );
    } catch {
      // Non-critical — cache metadata write failed
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

    // Cap at 90 thumbnails regardless of video length.
    const MAX_THUMBS = 90;
    const thumbnailTarget = Math.min(MAX_THUMBS, Math.max(8, Math.round(duration / 4)));
    const fps = duration > 0 ? thumbnailTarget / duration : 1;
    const thumbPattern = await join(clipFolder, "thumb_%04d.jpg");

    const thumbArgs = [
      "-y",
      "-threads", "1",                 // single thread — less contention with the UI
      "-skip_frame", "nokey",          // only decode I-frames (huge speedup on 4K)
      "-an",                            // skip audio — not needed for thumbnails
      "-i", videoPath,
      "-vf", `fps=${fps.toFixed(4)},scale=320:-1:flags=fast_bilinear`,  // 320px wide, fast scaling
      "-vsync", "vfr",                 // variable frame-rate to match keyframe timing
      "-q:v", "9",                     // low-quality JPEG — fine for tiny timeline thumbs
      thumbPattern,
    ];

    // Spawn ffmpeg and poll for thumbnails as they are written to disk
    const handle = await spawnFfmpeg(thumbArgs, token);

    let lastEmittedCount = 0;
    let pollActive = true;

    const poll = async () => {
      while (pollActive && !token?.cancelled) {
        await new Promise((r) => setTimeout(r, 250));
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
