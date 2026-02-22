import type { TimelineModel } from "./types";
import type { ClipRange } from "../store/types";
import { runFfmpeg, runFfmpegWithStdin } from "../services/FfmpegService";

interface FrameExportOptions {
  videoPath: string;
  clips: ClipRange[];
  timelineModel: TimelineModel;
  outputPath: string;
  width: number;
  height: number;
  fps?: number;
  onProgress?: (percent: number, status: string) => void;
}

type OverlayWorkerOutMessage =
  | { type: "ready" }
  | { type: "frame"; frameIndex: number; buffer: ArrayBuffer }
  | { type: "done" }
  | { type: "error"; message: string };

type OverlayWorkerInMessage =
  | { type: "init"; width: number; height: number; timelineModel: TimelineModel }
  | { type: "start"; totalFrames: number; fps: number }
  | { type: "recycle"; buffer: ArrayBuffer };

type VideoEncoderProfile =
  | {
      codecArgs: string[];
      label: "h264_nvenc" | "h264_qsv" | "libx264";
    };

let detectedEncoderProfilePromise: Promise<VideoEncoderProfile> | null = null;

function buildConcatOverlayFilter(clips: ClipRange[]): string {
  const parts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    parts.push(
      `[1:v]trim=start=${clips[i].start_time}:end=${clips[i].end_time},setpts=PTS-STARTPTS[v${i}]`,
    );
    parts.push(
      `[1:a]atrim=start=${clips[i].start_time}:end=${clips[i].end_time},asetpts=PTS-STARTPTS[a${i}]`,
    );
    concatInputs.push(`[v${i}]`, `[a${i}]`);
  }

  parts.push(`${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[vcat][aout]`);
  parts.push(`[0:v]format=rgba,setpts=PTS-STARTPTS[ov]`);
  parts.push(`[vcat][ov]overlay=0:0:shortest=1[vout]`);

  return parts.join("; ");
}

async function detectVideoEncoderProfile(): Promise<VideoEncoderProfile> {
  if (detectedEncoderProfilePromise) {
    return detectedEncoderProfilePromise;
  }

  detectedEncoderProfilePromise = (async () => {
    try {
      const encodersOutput = await runFfmpeg(["-hide_banner", "-encoders"]);
      const lower = encodersOutput.toLowerCase();

      if (lower.includes("h264_nvenc")) {
        return {
          label: "h264_nvenc",
          codecArgs: [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-b:v",
            "40M",
            "-maxrate",
            "50M",
            "-bufsize",
            "80M",
          ],
        };
      }

      if (lower.includes("h264_qsv")) {
        return {
          label: "h264_qsv",
          codecArgs: ["-c:v", "h264_qsv"],
        };
      }
    } catch {
      // fallback to software encode
    }

    return {
      label: "libx264",
      codecArgs: [
        "-c:v",
        "libx264",
        "-preset",
        "superfast",
        "-crf",
        "18",
        "-threads",
        "0",
      ],
    };
  })();

  return detectedEncoderProfilePromise;
}

async function createAndInitOverlayWorker(
  width: number,
  height: number,
  timelineModel: TimelineModel,
): Promise<Worker> {
  const worker = new Worker(new URL("./OverlayRenderWorker.ts", import.meta.url), {
    type: "module",
  });

  await new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent<OverlayWorkerOutMessage>) => {
      if (event.data.type === "ready") {
        worker.removeEventListener("message", onMessage);
        resolve();
        return;
      }
      if (event.data.type === "error") {
        worker.removeEventListener("message", onMessage);
        reject(new Error(event.data.message));
      }
    };

    const onError = (event: ErrorEvent) => {
      worker.removeEventListener("message", onMessage);
      reject(event.error ?? new Error(event.message));
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError, { once: true });

    const initMessage: OverlayWorkerInMessage = {
      type: "init",
      width,
      height,
      timelineModel,
    };
    worker.postMessage(initMessage);
  });

  return worker;
}

/**
 * Overlay streaming export pipeline.
 * Browser renders overlay RGBA frames and streams raw bytes to ffmpeg stdin.
 * ffmpeg handles source decode, clip trim/concat, overlay composition, and encode.
 */
export async function exportWithFrames(
  options: FrameExportOptions,
): Promise<string> {
  const {
    videoPath,
    clips,
    timelineModel,
    outputPath,
    width,
    height,
    onProgress,
  } = options;
  const fps = options.fps ?? 30;
  const duration = clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.end_time - clip.start_time),
    0,
  );
  const totalFrames = Math.ceil(duration * fps);

  if (totalFrames <= 0) {
    throw new Error("No frames to export");
  }
  if (width <= 0 || height <= 0) {
    throw new Error("Invalid export dimensions");
  }

  onProgress?.(0, "Preparing frame export...");

  const filterComplex = buildConcatOverlayFilter(clips);
  const encoderProfile = await detectVideoEncoderProfile();
  const overlayWorker = await createAndInitOverlayWorker(width, height, timelineModel);
  let maxPercent = 0;

  const ffmpegArgs = [
  "-y",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "rgba",
  "-s",
  `${width}x${height}`,
  "-r",
  String(fps),
  "-i",
  "pipe:0",
  "-f",
  "null",
  "-"
];

  try {
    await runFfmpegWithStdin(
      ffmpegArgs,
      async ({ write, flush }) => {
      const startTime = performance.now();
      let framesProcessed = 0;

      await new Promise<void>((resolve, reject) => {
        const pendingRecycleWrites = new Set<Promise<void>>();

        const onMessage = (event: MessageEvent<OverlayWorkerOutMessage>) => {
          const payload = event.data;
          if (payload.type === "frame") {
            framesProcessed = payload.frameIndex + 1;
            const writePromise = write(new Uint8Array(payload.buffer))
              .then(() => {
                const recycleMessage: OverlayWorkerInMessage = {
                  type: "recycle",
                  buffer: payload.buffer,
                };
                overlayWorker.postMessage(recycleMessage, [payload.buffer]);
              })
              .finally(() => {
                pendingRecycleWrites.delete(writePromise);
              });

            pendingRecycleWrites.add(writePromise);

            const elapsed = (performance.now() - startTime) / 1000;
            const effectiveFps = framesProcessed / Math.max(elapsed, 0.0001);
            const percent = (framesProcessed / totalFrames) * 90;
            maxPercent = Math.max(maxPercent, percent);
            onProgress?.(
              percent,
              `Rendering ${percent.toFixed(1)}% (${framesProcessed}/${totalFrames}) @ ${effectiveFps.toFixed(1)} FPS`,
            );
            return;
          }

          if (payload.type === "done") {
            overlayWorker.removeEventListener("message", onMessage);
            Promise.all([...pendingRecycleWrites])
              .then(() => resolve())
              .catch((error) => reject(error));
            return;
          }

          if (payload.type === "error") {
            overlayWorker.removeEventListener("message", onMessage);
            reject(new Error(payload.message));
          }
        };

        const onError = (event: ErrorEvent) => {
          overlayWorker.removeEventListener("message", onMessage);
          reject(event.error ?? new Error(event.message));
        };

        overlayWorker.addEventListener("message", onMessage);
        overlayWorker.addEventListener("error", onError, { once: true });
        const startMessage: OverlayWorkerInMessage = { type: "start", totalFrames, fps };
        overlayWorker.postMessage(startMessage);
      });

      await flush();
      const totalElapsed = (performance.now() - startTime) / 1000;
      const finalFps = totalFrames / Math.max(totalElapsed, 0.0001);
      console.log(
        `Export feed complete. Effective FPS: ${finalFps.toFixed(2)} (${encoderProfile.label})`,
      );

      maxPercent = Math.max(maxPercent, 90);
      onProgress?.(90, "Encoding video...");
      },
      {
        onProgress: (payload) => {
        if (payload.key === "frame") {
          const frame = Number.parseInt(payload.value, 10);
          if (Number.isFinite(frame)) {
            const encodingPercent = 90 + (frame / totalFrames) * 10;
            const nextPercent = Math.min(99, Math.max(maxPercent, encodingPercent));
            maxPercent = Math.max(maxPercent, nextPercent);
            onProgress?.(
              nextPercent,
              `Encoding ${nextPercent.toFixed(1)}% (${frame}/${totalFrames})`,
            );
          }
        }

        if (payload.key === "progress" && payload.value === "end") {
          onProgress?.(100, `Export complete (Processed ${totalFrames} frames)`);
        }
        },
      },
    );
  } finally {
    overlayWorker.terminate();
  }

  return outputPath;
}
