import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const ALLOWED_PROGRAM = "ffmpeg";

export interface FfmpegProgressPayload {
  key: string;
  value: string;
}

interface RunFfmpegOptions {
  onProgress?: (payload: FfmpegProgressPayload) => void;
}

export async function runFfmpeg(
  args: string[],
  options?: RunFfmpegOptions
): Promise<string> {
  let unlisten: UnlistenFn | null = null;
  let progressEvent: string | null = null;

  if (options?.onProgress) {
    progressEvent = `ffmpeg-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    unlisten = await listen<FfmpegProgressPayload>(progressEvent, (event) => {
      if (event.payload) {
        options.onProgress?.(event.payload);
      }
    });
  }

  try {
    return await invoke<string>("run_ffmpeg", {
      program: ALLOWED_PROGRAM,
      args,
      progressEvent,
    });
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
}
