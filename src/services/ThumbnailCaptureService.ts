import type { TimelineThumbnail } from "../store/timelineStore";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class ThumbnailCaptureService {
  static async captureFromVideo(
    video: HTMLVideoElement,
    duration: number
  ): Promise<TimelineThumbnail[]> {
    if (!video || !Number.isFinite(duration) || duration <= 0) {
      return [];
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return [];
    }

    const frameTarget = Math.min(60, Math.max(12, Math.round(duration / 2) || 12));
    const frameCount = Math.max(1, frameTarget);
    const wasPlaying = !video.paused && !video.ended;
    const previousTime = video.currentTime;
    const thumbnails: TimelineThumbnail[] = [];

    const targetWidth = Math.min(320, Math.max(160, video.videoWidth));
    const aspect = video.videoWidth / video.videoHeight;
    const targetHeight = Math.max(90, Math.round(targetWidth / (aspect || 1.777))); // default to ~16:9
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return [];
    }

    video.pause();

    const step = frameCount === 1 ? 0 : duration / (frameCount - 1);

    try {
      for (let i = 0; i < frameCount; i++) {
        const captureTime = clamp(i * step, 0, duration);
        await ThumbnailCaptureService.seekTo(video, captureTime);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbnails.push({ time: captureTime, src: canvas.toDataURL("image/jpeg", 0.75) });
      }
    } finally {
      const safeTime = clamp(previousTime, 0, duration);
      try {
        await ThumbnailCaptureService.seekTo(video, safeTime);
      } catch {
        video.currentTime = safeTime;
      }
      if (wasPlaying) {
        void video.play().catch(() => undefined);
      }
    }

    return thumbnails;
  }

  private static seekTo(video: HTMLVideoElement, time: number) {
    return new Promise<void>((resolve, reject) => {
      const handleSeeked = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error("Video error during thumbnail capture"));
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out seeking video frame"));
      }, 5000);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        video.removeEventListener("seeked", handleSeeked);
        video.removeEventListener("error", handleError);
      };

      video.addEventListener("seeked", handleSeeked, { once: true });
      video.addEventListener("error", handleError, { once: true });

      try {
        video.currentTime = clamp(time, 0, video.duration || time);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
