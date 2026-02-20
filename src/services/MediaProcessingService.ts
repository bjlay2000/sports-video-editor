import { exists, mkdir, readDir, remove } from "@tauri-apps/plugin-fs";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { TimelineThumbnail } from "../store/timelineStore";
import { runFfmpeg } from "./FfmpegService";

export interface TimelineAssets {
  thumbnails: TimelineThumbnail[];
  waveformSrc: string | null;
  poster?: string | null;
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
  static async generateTimelineAssets(
    videoPath: string,
    duration: number
  ): Promise<TimelineAssets> {
    const cacheRoot = await appCacheDir();
    const previewsRoot = await join(cacheRoot, "sve-previews");
    await ensureDir(previewsRoot);

    const clipFolder = await join(
      previewsRoot,
      sanitizeSegment(videoPath)
    );
    await resetDir(clipFolder);

    const thumbnailTarget = Math.min(60, Math.max(12, Math.round(duration / 2)));
    const fps = duration > 0 ? thumbnailTarget / duration : 1;
    const thumbPattern = await join(clipFolder, "thumb_%03d.jpg");

    const thumbArgs = [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=${fps.toFixed(3)},scale=320:-1`,
      "-qscale:v",
      "3",
      thumbPattern,
    ];

    const waveformPath = await join(clipFolder, "waveform.png");
    const waveformArgs = [
      "-y",
      "-i",
      videoPath,
      "-filter_complex",
      "aformat=channel_layouts=mono,showwavespic=s=1800x200",
      "-frames:v",
      "1",
      waveformPath,
    ];

    await runFfmpeg(thumbArgs);
    await runFfmpeg(waveformArgs);

    const entries = await readDir(clipFolder);
    const thumbEntries = entries
      .filter((entry) => entry.name.startsWith("thumb_"))
      .sort((a, b) => a.name.localeCompare(b.name));

    const thumbs: TimelineThumbnail[] = [];
    const interval = duration / Math.max(thumbEntries.length, 1);
    for (let i = 0; i < thumbEntries.length; i++) {
      const entry = thumbEntries[i];
      const filePath = await join(clipFolder, entry.name);
      thumbs.push({
        time: Math.min(duration, i * interval),
        src: convertFileSrc(filePath),
      });
    }

    let waveformSrc: string | null = null;
    if (await exists(waveformPath)) {
      waveformSrc = convertFileSrc(waveformPath);
    }

    return {
      thumbnails: thumbs,
      waveformSrc,
      poster: thumbs[0]?.src,
    };
  }
}
