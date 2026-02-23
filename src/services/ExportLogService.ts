import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, open } from "@tauri-apps/plugin-fs";

const LOG_DIR_NAME = "export-logs";
const encoder = new TextEncoder();

let cachedLogFilePath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let initialized = false;

function formatTimestamp(date: Date): string {
  const time = date.toLocaleTimeString("en-US", { hour12: false });
  return `${date.toISOString()} (${time}.${String(date.getMilliseconds()).padStart(3, "0")})`;
}

async function resolveLogFilePath(): Promise<string> {
  if (cachedLogFilePath) {
    return cachedLogFilePath;
  }

  const root = await appCacheDir();
  const logDir = await join(root, LOG_DIR_NAME);
  if (!(await exists(logDir))) {
    await mkdir(logDir, { recursive: true });
  }

  const day = new Date().toISOString().slice(0, 10);
  cachedLogFilePath = await join(logDir, `export-${day}.logs`);
  return cachedLogFilePath;
}

async function appendLine(line: string): Promise<void> {
  const path = await resolveLogFilePath();
  const handle = await open(path, {
    create: true,
    write: true,
    append: true,
  });

  try {
    await handle.write(encoder.encode(`${line}\n`));
  } finally {
    await handle.close();
  }

  // Mirror the same line to workspace ffmpeg-monitor.log for live debugging parity.
  try {
    await invoke("append_ffmpeg_monitor_log", { line });
  } catch (error) {
    console.error("[EXPORT-LOG] Failed to mirror line to ffmpeg-monitor.log", error);
  }
}

function enqueue(line: string): void {
  writeQueue = writeQueue
    .then(() => appendLine(line))
    .catch((error) => {
      console.error("[EXPORT-LOG] Failed to write export log file", error);
    });
}

function collectRuntimeMetadata(): string[] {
  const metadata: string[] = [];
  metadata.push(`runtime.platform=${navigator.platform}`);
  metadata.push(`runtime.userAgent=${navigator.userAgent}`);
  metadata.push(`runtime.language=${navigator.language}`);
  metadata.push(`runtime.hardwareConcurrency=${navigator.hardwareConcurrency ?? "unknown"}`);
  const maybeMemory = (performance as Performance & { memory?: { jsHeapSizeLimit?: number; totalJSHeapSize?: number; usedJSHeapSize?: number } }).memory;
  if (maybeMemory) {
    metadata.push(`runtime.heap.used=${maybeMemory.usedJSHeapSize ?? "n/a"}`);
    metadata.push(`runtime.heap.total=${maybeMemory.totalJSHeapSize ?? "n/a"}`);
    metadata.push(`runtime.heap.limit=${maybeMemory.jsHeapSizeLimit ?? "n/a"}`);
  }
  metadata.push(`runtime.timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  return metadata;
}

export async function initializeExportLoggingSession(): Promise<void> {
  if (initialized) return;

  const path = await resolveLogFilePath();
  const handle = await open(path, {
    create: true,
    write: true,
    truncate: true,
  });

  try {
    const ts = formatTimestamp(new Date());
    const lines: string[] = [
      "=".repeat(88),
      `[${ts}] [AppLifecycle] STARTUP: export log reset on app launch`,
      `[${ts}] [AppLifecycle] logFile=${path}`,
      ...collectRuntimeMetadata().map((line) => `[${ts}] [AppLifecycle] ${line}`),
      "=".repeat(88),
      "",
    ];
    await handle.write(encoder.encode(lines.join("\n")));
    initialized = true;
  } finally {
    await handle.close();
  }
}

export function beginExportLogSession(context: string): void {
  const ts = formatTimestamp(new Date());
  const separator = "=".repeat(88);
  enqueue(separator);
  enqueue(`[${ts}] [ExportSession] START: ${context}`);
  enqueue(`[${ts}] [ExportSession] performance.timeOrigin=${performance.timeOrigin}`);
}

export function endExportLogSession(context: string): void {
  const ts = formatTimestamp(new Date());
  enqueue(`[${ts}] [ExportSession] END: ${context}`);
  enqueue("=".repeat(88));
}

export function logExportEvent(source: string, event: string): void {
  const ts = formatTimestamp(new Date());
  const line = `[${ts}] [${source}] ${event}`;
  console.log(line);
  enqueue(line);
}

export async function getExportLogFilePath(): Promise<string> {
  return resolveLogFilePath();
}
