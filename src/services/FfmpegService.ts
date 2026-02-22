import { Command } from "@tauri-apps/plugin-shell";

export interface FfmpegProgressPayload {
  key: string;
  value: string;
}

interface RunFfmpegOptions {
  onProgress?: (payload: FfmpegProgressPayload) => void;
}

type FfmpegWritablePayload = string | Uint8Array | number[];
const MAX_PENDING_STDIN_BYTES = 16 * 1024 * 1024;

interface FfmpegStdinWriter {
  write: (data: FfmpegWritablePayload) => Promise<void>;
  flush: () => Promise<void>;
}

function payloadByteLength(data: FfmpegWritablePayload): number {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  return data.length;
}

function bindProgressParser(
  command: Command<string>,
  onProgress?: (payload: FfmpegProgressPayload) => void,
): void {
  if (!onProgress) {
    return;
  }

  let stdoutBuffer = "";
  command.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("=");
      if (parts.length < 2) continue;
      const key = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      onProgress({ key, value });
    }
  });
}

export async function runFfmpeg(
  args: string[],
  options?: RunFfmpegOptions
): Promise<string> {
  if (!options?.onProgress) {
    const output = await Command.create("ffmpeg", args).execute();
    if (output.code === 0) {
      return output.stdout;
    }
    throw new Error(output.stderr || "ffmpeg failed");
  }

  const command = Command.create("ffmpeg", args);
  bindProgressParser(command, options.onProgress);

  const stderrChunks: string[] = [];
  command.stderr.on("data", (line) => stderrChunks.push(line));

  const output = await command.execute();
  if (output.code === 0) {
    return output.stdout;
  }
  throw new Error(stderrChunks.join("") || output.stderr || "ffmpeg failed");
}

export async function runFfmpegWithStdin(
  args: string[],
  writeInput: (writer: FfmpegStdinWriter) => Promise<void>,
  options?: RunFfmpegOptions,
): Promise<string> {
  const command = Command.create("ffmpeg", args);
  bindProgressParser(command, options?.onProgress);

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];

  command.stdout.on("data", (line) => stdoutChunks.push(line));
  command.stderr.on("data", (line) => stderrChunks.push(line));

  let exitCode: number | null = null;
  let exitSignal: number | null = null;
  let commandError: string | null = null;

  const closePromise = new Promise<void>((resolve, reject) => {
    command.on("close", ({ code, signal }) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
    command.on("error", (error) => {
      commandError = error;
      reject(new Error(error));
    });
  });

  const child = await command.spawn();

  const inflightWrites = new Set<Promise<void>>();
  let pendingBytes = 0;

  const writer: FfmpegStdinWriter = {
    write: async (data) => {
      const byteLength = payloadByteLength(data);
      if (pendingBytes >= MAX_PENDING_STDIN_BYTES) {
        await Promise.all([...inflightWrites]);
      }

      pendingBytes += byteLength;
      let writePromise: Promise<void>;
      writePromise = child.write(data).finally(() => {
        pendingBytes = Math.max(0, pendingBytes - byteLength);
        inflightWrites.delete(writePromise);
      });
      inflightWrites.add(writePromise);
      return writePromise;
    },
    flush: async () => {
      await Promise.all([...inflightWrites]);
    },
  };

  try {
    await writeInput(writer);
    await writer.flush();
    await closePromise;
  } catch (error) {
    try {
      await child.kill();
    } catch {
      // ignore kill failures
    }
    throw error;
  }

  if (commandError) {
    throw new Error(commandError);
  }

  if (exitCode === 0) {
    return stdoutChunks.join("");
  }

  throw new Error(
    stderrChunks.join("") ||
      `ffmpeg failed${exitSignal ? ` (signal ${exitSignal})` : ""}`,
  );
}
