import { useState } from "react";
import { useAppStore } from "../store/appStore";
import { useVideoStore } from "../store/videoStore";
import { useTimelineStore } from "../store/timelineStore";
import { useToastStore } from "../store/toastStore";
import { ExportService } from "../services/ExportService";
import { open, save } from "@tauri-apps/plugin-dialog";
import { MediaLibrary } from "../services/MediaLibrary";
import { PlayCoordinator } from "../services/PlayCoordinator";

export function Toolbar() {
  const [confirmAction, setConfirmAction] = useState<null | "clear-tags" | "clear-highlights" | "new-game">(null);
  const [showOverlayPrompt, setShowOverlayPrompt] = useState(false);
  const videoPath = useVideoStore((s) => s.videoPath);
  const duration = useVideoStore((s) => s.duration);
  const showScoreboardOverlay = useVideoStore((s) => s.showScoreboardOverlay);
  const toggleScoreboardOverlay = useVideoStore((s) => s.toggleScoreboardOverlay);
  const plays = useAppStore((s) => s.plays);
  const markers = useAppStore((s) => s.markers);
  const setShowHighlightModal = useAppStore((s) => s.setShowHighlightModal);
  const setIsExporting = useAppStore((s) => s.setIsExporting);
  const isExporting = useAppStore((s) => s.isExporting);
  const setExportProgressVisible = useAppStore((s) => s.setExportProgressVisible);
  const updateExportProgress = useAppStore((s) => s.updateExportProgress);
  const segments = useTimelineStore((s) => s.segments);
  const pushToast = useToastStore((s) => s.pushToast);

  const handleLoadVideo = async () => {
    try {
      const selection = await open({
        multiple: false,
        filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv"] }],
      });
      if (!selection) return;
      const filePath = Array.isArray(selection) ? selection[0] : selection;
      if (typeof filePath === "string") {
        await MediaLibrary.loadClipFromPath(filePath);
      }
    } catch (err) {
      console.error("Failed to load video", err);
    }
  };

  const handleExportFull = async () => {
    if (!videoPath) return;
    const usableSegments = segments.length
      ? segments.filter((segment) => segment.end > segment.start)
      : duration > 0
        ? [{ start: 0, end: duration }]
        : [];
    if (usableSegments.length === 0) {
      alert("No video range available to export.");
      return;
    }

    const clips = usableSegments.map((segment) => ({
      start_time: Math.max(0, segment.start),
      end_time: Math.max(segment.start, segment.end),
    }));

    const targetPath = await save({
      defaultPath: "full_export.mp4",
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });

    if (!targetPath) {
      return;
    }

    const normalizedPath = targetPath.toLowerCase().endsWith(".mp4")
      ? targetPath
      : `${targetPath}.mp4`;

    setIsExporting(true);
    setExportProgressVisible(true, "Exporting Full Video");
    try {
      await ExportService.exportFull(videoPath, clips, normalizedPath, {
        onProgress: (update) => {
          updateExportProgress(update.percent, update.status);
        },
      });
      pushToast("Export complete", "success");
    } catch (e: any) {
      console.error(e);
      pushToast(`Export failed: ${e?.message ?? e}`, "error");
    } finally {
      setIsExporting(false);
      setExportProgressVisible(false);
    }
  };

  const handleExportHighlights = () => {
    if (!videoPath || plays.length === 0) return;
    if (showScoreboardOverlay) {
      setShowOverlayPrompt(true);
      return;
    }
    setShowHighlightModal(true);
  };

  const handleClearTags = () => {
    if (plays.length === 0) return;
    setConfirmAction("clear-tags");
  };

  const handleClearHighlights = () => {
    const hasHighlights = markers.some((marker) => marker.event_type === "HIGHLIGHT");
    if (!hasHighlights) return;
    setConfirmAction("clear-highlights");
  };

  const handleNewGame = () => {
    setConfirmAction("new-game");
  };

  const handleConfirmDestructiveAction = async () => {
    const action = confirmAction;
    if (!action) return;
    try {
      if (action === "clear-tags") {
        await PlayCoordinator.clearAllStatTags();
      } else if (action === "clear-highlights") {
        PlayCoordinator.clearAllHighlights();
      } else if (action === "new-game") {
        await PlayCoordinator.resetGame();
      }
    } finally {
      setConfirmAction(null);
    }
  };

  const confirmTitle =
    confirmAction === "clear-tags"
      ? "Clear Tags"
      : confirmAction === "clear-highlights"
        ? "Clear Highlights"
        : "New Game";

  const confirmMessage =
    confirmAction === "clear-tags"
      ? "Remove all recorded stat tags?"
      : confirmAction === "clear-highlights"
        ? "Remove all highlight tags?"
        : "Start a new game? This will reset score, stat tags, highlights, and manual markers.";

  return (
    <>
      <div className="h-12 bg-surface-dark border-b border-panel-border flex items-center px-4 gap-3 shrink-0">
        <span className="text-accent font-bold text-lg mr-4">SVE</span>

      <button
        onClick={handleLoadVideo}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors"
      >
        Load Video
      </button>

      <button
        onClick={handleExportFull}
        disabled={
          isExporting ||
          !videoPath ||
          (segments.length === 0 && duration <= 0)
        }
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isExporting ? "Exporting..." : "Export Full"}
      </button>

      <button
        onClick={handleExportHighlights}
        disabled={isExporting || !videoPath || plays.length === 0}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Export Highlights
      </button>

      <div className="w-px h-6 bg-panel-border mx-2" />

      <button
        onClick={handleClearTags}
        disabled={plays.length === 0}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Clear Tags
      </button>

      <button
        onClick={handleClearHighlights}
        disabled={!markers.some((marker) => marker.event_type === "HIGHLIGHT")}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Clear Highlights
      </button>

      <button
        onClick={handleNewGame}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors"
      >
        New Game
      </button>

        <div className="flex-1" />
      </div>

      {showOverlayPrompt && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-panel border border-panel-border rounded-lg p-5 w-96">
            <h2 className="text-lg font-semibold text-white mb-2">Overlays Enabled</h2>
            <p className="text-sm text-gray-300 mb-4">
              Turn off overlays before opening highlight export?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  toggleScoreboardOverlay(false);
                  setShowOverlayPrompt(false);
                  setShowHighlightModal(true);
                }}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover rounded text-sm transition-colors"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowOverlayPrompt(false);
                  setShowHighlightModal(true);
                }}
                className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-panel border border-panel-border rounded-lg p-5 w-96">
            <h2 className="text-lg font-semibold text-white mb-2">{confirmTitle}</h2>
            <p className="text-sm text-gray-300 mb-4">{confirmMessage}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDestructiveAction}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover rounded text-sm transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
