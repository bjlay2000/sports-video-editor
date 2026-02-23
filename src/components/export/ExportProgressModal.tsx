import { useMemo, useState } from "react";
import { ExportService } from "../../services/ExportService";
import { useAppStore } from "../../store/appStore";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

export function ExportProgressModal() {
  const [cancelling, setCancelling] = useState(false);
  const visible = useAppStore((s) => s.exportProgressVisible);
  const title = useAppStore((s) => s.exportProgressTitle);
  const percent = useAppStore((s) => s.exportProgressPercent);
  const status = useAppStore((s) => s.exportProgressStatus);
  const isExporting = useAppStore((s) => s.isExporting);
  const thumbnailUrl = useAppStore((s) => s.exportThumbnailUrl);
  const timeRemaining = useAppStore((s) => s.exportTimeRemaining);
  const currentProcess = useAppStore((s) => s.exportCurrentProcess);
  const completionStats = useAppStore((s) => s.exportCompletionStats);
  const updateExportProgress = useAppStore((s) => s.updateExportProgress);
  const setExportProgressVisible = useAppStore((s) => s.setExportProgressVisible);
  const setIsExporting = useAppStore((s) => s.setIsExporting);
  const setExportCompletionStats = useAppStore((s) => s.setExportCompletionStats);

  const isComplete = !isExporting && !!completionStats;
  const avgFps = useMemo(() => {
    if (!completionStats || completionStats.encodeElapsedMs <= 0) return 0;
    return completionStats.totalFrames / (completionStats.encodeElapsedMs / 1000);
  }, [completionStats]);

  const handleCancel = async () => {
    if (!isExporting || cancelling) return;

    setCancelling(true);
    updateExportProgress(percent, "Cancelling export...");
    try {
      const cancelled = await ExportService.cancelActiveExport();
      if (!cancelled) {
        setIsExporting(false);
        setExportProgressVisible(false);
      }
    } finally {
      setCancelling(false);
    }
  };

  const handleOk = () => {
    setExportCompletionStats(null);
    setExportProgressVisible(false);
  };

  if (!visible) {
    return null;
  }

  // Extract a short label from the current process (strip the "functionName: " prefix context)
  const processLabel = currentProcess
    ? currentProcess.replace(/^[\w]+:\s*/, "")
    : "";

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-xl border border-panel-border bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-white mb-4">
          {isComplete ? "Export Complete" : title || "Export"}
        </h2>
        {thumbnailUrl && (
          <div className="mb-4 rounded-lg overflow-hidden border border-panel-border">
            <img
              src={thumbnailUrl}
              alt="Export preview"
              className="w-full h-auto object-cover"
              draggable={false}
            />
          </div>
        )}
        <p className="text-sm text-gray-300 mb-2 truncate" title={title}>
          {title || "Untitled"}
        </p>
        <div className="flex items-center gap-3 mb-1">
          <span className="text-sm text-white font-medium min-w-[2.5rem]">
            {Math.floor(isComplete ? 100 : percent)}%
          </span>
          <div className="flex-1 h-2 rounded-full bg-panel-border/40 overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.max(0, Math.min(100, isComplete ? 100 : percent)).toFixed(1)}%` }}
            />
          </div>
          {isExporting && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="text-gray-400 hover:text-white transition-colors disabled:opacity-40"
              title={cancelling ? "Cancelling..." : "Cancel"}
            >
              {cancelling ? "⏳" : "⏸"}
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400">
          {isComplete ? "Export finished successfully." : status || "Preparing export..."}
        </p>
        {processLabel && (
          <p className="text-xs text-gray-500 mt-1 truncate" title={currentProcess}>
            {processLabel}
          </p>
        )}
        {!isComplete && (
          <p className="text-xs text-gray-500 mt-1">
            Time remaining: {timeRemaining || "calculating..."}
          </p>
        )}

        {isComplete && completionStats && (
          <div className="mt-4 rounded-lg border border-panel-border bg-surface p-3 space-y-1 text-xs text-gray-300">
            <p>Output: <span className="text-white">{completionStats.outputPath}</span></p>
            <p>Size: <span className="text-white">{formatFileSize(completionStats.outputSizeBytes)}</span></p>
            <p>Encoder: <span className="text-white">{completionStats.encoderDisplay}</span></p>
            <p>Hardware: <span className="text-white">{completionStats.vendorDisplay}</span></p>
            <p>Resolution: <span className="text-white">{completionStats.exportWidth}×{completionStats.exportHeight} @ {completionStats.fps}fps</span></p>
            <p>Clip duration: <span className="text-white">{completionStats.totalDurationSec.toFixed(2)}s</span></p>
            <p>Total time: <span className="text-white">{formatDuration(completionStats.totalElapsedMs)}</span></p>
            <p>Encode time: <span className="text-white">{formatDuration(completionStats.encodeElapsedMs)}</span></p>
            <p>Average encode FPS: <span className="text-white">{avgFps.toFixed(2)}</span></p>
          </div>
        )}

        {isComplete && (
          <button
            onClick={handleOk}
            className="mt-4 w-full py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors"
          >
            OK
          </button>
        )}
      </div>
    </div>
  );
}
