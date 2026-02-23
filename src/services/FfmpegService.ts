import { Command } from "@tauri-apps/plugin-shell";
import { logExportEvent } from "./ExportLogService";

export interface FfmpegProgressPayload {
  key: string;
  value: string;
}

function ffLog(event: string): void {
  logExportEvent("FfmpegService", event);
}

/* ── Cancel-token for concurrent / background ffmpeg processes ── */

export interface FfmpegCancelToken {
  cancelled: boolean;
  /** @internal – kill callbacks registered by spawned processes */
  _kills: Array<() => Promise<void>>;
}

export function createCancelToken(): FfmpegCancelToken {
  ffLog("createCancelToken");
  return { cancelled: false, _kills: [] };
}

export function cancelFfmpegToken(token: FfmpegCancelToken): void {
  ffLog("cancelFfmpegToken: cancelling token and child kills");
  token.cancelled = true;
  for (const kill of token._kills) {
    kill().catch(() => {});
  }
  token._kills = [];
}

/* ── Spawn-based helper (non-blocking, supports cancel token) ── */

export interface FfmpegChildHandle {
  /** Resolves when the process exits successfully, rejects on error / cancel */
  done: Promise<void>;
  /** Kill the child process */
  kill: () => Promise<void>;
}

/**
 * Spawn an ffmpeg process that can be cancelled via a token and whose
 * completion can be awaited independently.  Used for background jobs
 * (thumbnail generation, waveform) so multiple ffmpeg calls can run
 * concurrently without clobbering `activeCancel`.
 */
export async function spawnFfmpeg(
  args: string[],
  cancelToken?: FfmpegCancelToken,
): Promise<FfmpegChildHandle> {
  ffLog(`spawnFfmpeg: start args=[${args.join(" ")}]`);
  if (cancelToken?.cancelled) throw new Error("ffmpeg cancelled");

  const command = Command.create("ffmpeg", args);
  const stderrChunks: string[] = [];
  command.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    command.on("close", ({ code }) => {
      ffLog(`spawnFfmpeg: process closed code=${code}`);
      if (cancelToken?.cancelled) {
        reject(new Error("ffmpeg cancelled"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderrChunks.join("") || `ffmpeg failed (code ${code})`));
      }
    });
    command.on("error", (err) => {
      ffLog(`spawnFfmpeg: process error ${err}`);
      reject(new Error(err));
    });
  });

  const child = await command.spawn();
  ffLog("spawnFfmpeg: process spawned");

  const killFn = async () => {
    try {
      ffLog("spawnFfmpeg: kill requested");
      await child.kill();
    } catch {
      /* ignore kill errors */
    }
  };

  if (cancelToken) {
    cancelToken._kills.push(killFn);
    if (cancelToken.cancelled) {
      await killFn();
      throw new Error("ffmpeg cancelled");
    }
  }

  return { done, kill: killFn };
}

/* ── Export-specific single-process cancel (used by ExportService) ── */

interface RunFfmpegOptions {
  onProgress?: (payload: FfmpegProgressPayload) => void;
  /** Soft stall threshold: only logs warnings when crossed. */
  stallTimeoutMs?: number;
  /** Optional hard timeout from last forward progress; when crossed, process is killed. */
  stallHardTimeoutMs?: number;
  /** Minimum interval between repeated soft-stall warning logs. */
  stallLogIntervalMs?: number;
  cancelToken?: FfmpegCancelToken;
}

let activeCancel: (() => Promise<void>) | null = null;

export async function cancelActiveFfmpeg(): Promise<boolean> {
  if (!activeCancel) {
    ffLog("cancelActiveFfmpeg: no active process");
    return false;
  }

  ffLog("cancelActiveFfmpeg: invoking active cancel");
  await activeCancel();
  return true;
}

function bindProgressParser(
  command: Command<string>,
  onProgress?: (payload: FfmpegProgressPayload) => void,
): void {
  if (!onProgress) {
    return;
  }

  const parseChunk = (chunk: string, state: { buffer: string }) => {
    state.buffer += chunk;
    const lines = state.buffer.split(/\r?\n|\r/);
    state.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("=");
      if (parts.length < 2) continue;
      const key = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      ffLog(`progress-payload: ${key}=${value}`);
      onProgress({ key, value });
    }
  };

  const stdoutState = { buffer: "" };

  // Progress key/value events are emitted from -progress pipe:1 (stdout).
  // Avoid parsing stderr stats lines (e.g. "frame= ... fps= ...") as progress
  // payloads because they can cause stale/non-monotonic frame values.
  command.stdout.on("data", (chunk) => parseChunk(chunk, stdoutState));
}

export async function runFfmpeg(
  args: string[],
  options?: RunFfmpegOptions
): Promise<string> {
  ffLog(`runFfmpeg: called args=[${args.join(" ")}] onProgress=${Boolean(options?.onProgress)} stallTimeoutMs=${options?.stallTimeoutMs ?? 90_000}`);
  if (!options?.onProgress) {
    // When a cancel token is provided, use spawn-based path for killability
    if (options?.cancelToken) {
      ffLog("runFfmpeg: using spawn path with cancel token");
      const handle = await spawnFfmpeg(args, options.cancelToken);
      await handle.done;
      ffLog("runFfmpeg: spawn path completed");
      return "";
    }
    ffLog("runFfmpeg: using execute path");
    const output = await Command.create("ffmpeg", args).execute();
    if (output.code === 0) {
      ffLog("runFfmpeg: execute path completed code=0");
      return output.stdout;
    }
    ffLog(`runFfmpeg: execute path failed code=${output.code}`);
    throw new Error(output.stderr || "ffmpeg failed");
  }

  const stallTimeoutMs = options.stallTimeoutMs ?? 90_000;
  const stallHardTimeoutMs = options.stallHardTimeoutMs ?? 0;
  const stallLogIntervalMs = options.stallLogIntervalMs ?? 5_000;
  const startedAt = Date.now();
  let lastForwardProgressAt = Date.now();
  let lastFrame = -1;
  let lastOutTimeUs = -1;
  let lastOutTimeSec = 0;
  let stallTriggered = false;
  let lastHeartbeatAt = 0;
  let stallWarningActive = false;
  let lastStallWarningAt = 0;

  const originalProgress = options.onProgress;
  const progressHandler =
    originalProgress
      ? (payload: FfmpegProgressPayload) => {
      if (payload.key === "frame") {
        const frame = Number.parseInt(payload.value, 10);
        if (Number.isFinite(frame) && frame > lastFrame) {
          if (stallWarningActive) {
            ffLog(
              `stall-recovered: forward progress resumed at frame=${frame} after ${((Date.now() - lastForwardProgressAt) / 1000).toFixed(1)}s`,
            );
            stallWarningActive = false;
          }
          lastFrame = frame;
          lastForwardProgressAt = Date.now();
          ffLog(`forward-progress: frame=${lastFrame}`);
        }
      }

      if (payload.key === "out_time_us" || payload.key === "out_time_ms") {
        const raw = Number.parseInt(payload.value, 10);
        if (Number.isFinite(raw) && raw >= 0) {
          const asMicros = raw;
          if (asMicros > lastOutTimeUs) {
            if (stallWarningActive) {
              ffLog(
                `stall-recovered: out_time advanced to ${(
                  asMicros / 1_000_000
                ).toFixed(3)}s after ${((Date.now() - lastForwardProgressAt) / 1000).toFixed(1)}s`,
              );
              stallWarningActive = false;
            }
            lastOutTimeUs = asMicros;
            lastOutTimeSec = asMicros / 1_000_000;
            lastForwardProgressAt = Date.now();
            ffLog(`forward-progress: out_time_s=${lastOutTimeSec.toFixed(3)}`);
          }
        }
      }

      if (payload.key === "progress" && payload.value === "end") {
        lastForwardProgressAt = Date.now();
      }

      const now = Date.now();
      if (now - lastHeartbeatAt >= 5_000) {
        lastHeartbeatAt = now;
        const runForSec = ((now - startedAt) / 1000).toFixed(1);
        const noProgressSec = ((now - lastForwardProgressAt) / 1000).toFixed(1);
        ffLog(
          `heartbeat: runForSec=${runForSec} frame=${lastFrame} outTimeSec=${lastOutTimeSec.toFixed(3)} noForwardProgressSec=${noProgressSec}`,
        );
      }

      originalProgress(payload);
        }
      : undefined;

  const command = Command.create("ffmpeg", args);
  ffLog("runFfmpeg: command created and parser bound");
  bindProgressParser(command, progressHandler);

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  command.stdout.on("data", (line) => stdoutChunks.push(line));
  command.stderr.on("data", (line) => {
    stderrChunks.push(line);
    const trimmed = String(line).trim();
    if (trimmed) {
      ffLog(`stderr: ${trimmed}`);
    }
  });

  let exitCode: number | null = null;
  let exitSignal: number | null = null;
  let commandError: string | null = null;
  let resolveRun: (() => void) | null = null;
  let rejectRun: ((error: Error) => void) | null = null;
  let userCancelled = false;
  let spawnedChild: Awaited<ReturnType<typeof command.spawn>> | null = null;

  const closePromise = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
    command.on("close", ({ code, signal }) => {
      ffLog(`runFfmpeg: close event code=${code} signal=${signal}`);
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
    command.on("error", (error) => {
      ffLog(`runFfmpeg: command error ${error}`);
      commandError = error;
      reject(new Error(error));
    });
  });

  const stallInterval =
    progressHandler && stallTimeoutMs > 0
      ? setInterval(() => {
          if (stallTriggered) return;
          const elapsed = Date.now() - lastForwardProgressAt;
          if (elapsed < stallTimeoutMs) return;

          if (!stallWarningActive) {
            stallWarningActive = true;
            ffLog(
              `soft-stall-detected: no forward progress for ${Math.floor(elapsed / 1000)}s (logging-only mode)`
            );
            ffLog(
              `stall-context: lastFrame=${lastFrame} lastOutTimeSec=${lastOutTimeSec.toFixed(3)} runForSec=${((Date.now() - startedAt) / 1000).toFixed(1)}`,
            );
            lastStallWarningAt = Date.now();
          }

          if (Date.now() - lastStallWarningAt >= stallLogIntervalMs) {
            lastStallWarningAt = Date.now();
            ffLog(
              `soft-stall-ongoing: stalledForSec=${Math.floor(elapsed / 1000)} frame=${lastFrame} outTimeSec=${lastOutTimeSec.toFixed(3)}`,
            );
          }

          if (stallHardTimeoutMs > 0 && elapsed >= stallHardTimeoutMs) {
            stallTriggered = true;
            ffLog(
              `hard-stall-timeout: killing process after ${Math.floor(elapsed / 1000)}s without forward progress`,
            );
            Promise.resolve(spawnedChild?.kill())
              .catch(() => {
                /* ignore kill errors */
              })
              .finally(() => {
                rejectRun?.(
                  new Error(
                    `ffmpeg hard stall timeout: no forward frame/time progress for ${Math.floor(elapsed / 1000)}s`,
                  ),
                );
              });
          }
        }, 1_000)
      : null;

  activeCancel = async () => {
    if (userCancelled) {
      return;
    }

    userCancelled = true;
    ffLog("runFfmpeg: activeCancel invoked");
    await Promise.resolve(spawnedChild?.kill()).catch(() => {
      /* ignore kill errors */
    });
    rejectRun?.(new Error("ffmpeg cancelled"));
  };

  spawnedChild = await command.spawn();
  ffLog("runFfmpeg: command spawned");

  try {
    await closePromise;
  } finally {
    if (stallInterval) {
      clearInterval(stallInterval);
    }
    resolveRun = null;
    rejectRun = null;
    activeCancel = null;
  }

  if (commandError) {
    ffLog(`runFfmpeg: throwing commandError ${commandError}`);
    throw new Error(commandError);
  }

  if (userCancelled) {
    ffLog("runFfmpeg: throwing cancelled");
    throw new Error("ffmpeg cancelled");
  }

  if (stallTriggered) {
    ffLog("runFfmpeg: throwing stalled and terminated");
    throw new Error("ffmpeg stalled and was terminated");
  }

  if (exitCode === 0) {
    ffLog("runFfmpeg: completed with exitCode 0");
    return stdoutChunks.join("");
  }
  ffLog(`runFfmpeg: failed with exitCode=${exitCode} signal=${exitSignal}`);
  throw new Error(
    stderrChunks.join("") ||
      `ffmpeg failed${exitSignal ? ` (signal ${exitSignal})` : ""}`,
  );
}
