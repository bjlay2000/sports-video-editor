import { useAppStore } from "../store/appStore";
import { useVideoStore } from "../store/videoStore";
import { useTimelineStore } from "../store/timelineStore";
import { useToastStore } from "../store/toastStore";
import { ExportService } from "../services/ExportService";
import { open, save } from "@tauri-apps/plugin-dialog";
import { MediaLibrary } from "../services/MediaLibrary";
import { PlayCoordinator } from "../services/PlayCoordinator";

export function Toolbar() {
  const videoPath = useVideoStore((s) => s.videoPath);
  const duration = useVideoStore((s) => s.duration);
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
    setShowHighlightModal(true);
  };

  const handleClearTags = async () => {
    if (plays.length === 0) return;
    const confirmed = window.confirm("Remove all recorded stat tags?");
    if (!confirmed) return;
    await PlayCoordinator.clearAllStatTags();
  };

  const handleClearHighlights = () => {
    const hasHighlights = markers.some((marker) => marker.event_type === "HIGHLIGHT");
    if (!hasHighlights) return;
    const confirmed = window.confirm("Remove all highlight tags?");
    if (!confirmed) return;
    PlayCoordinator.clearAllHighlights();
  };

  const handleNewGame = async () => {
    const confirmed = window.confirm(
      "Start a new game? This will reset the score, remove all stat tags, highlights, and manual markers."
    );
    if (!confirmed) return;
    await PlayCoordinator.resetGame();
  };

  return (
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
  );
}
