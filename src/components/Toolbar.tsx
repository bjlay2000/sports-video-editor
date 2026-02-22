import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { useVideoStore } from "../store/videoStore";
import { useTimelineStore } from "../store/timelineStore";
import { useToastStore } from "../store/toastStore";
import { ExportService } from "../services/ExportService";
import { open, save } from "@tauri-apps/plugin-dialog";
import { MediaLibrary } from "../services/MediaLibrary";
import { PlayCoordinator } from "../services/PlayCoordinator";
import { ProjectService } from "../services/ProjectService";

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
  const setShowExportStatsModal = useAppStore((s) => s.setShowExportStatsModal);
  const projectSavedSignature = useAppStore((s) => s.projectSavedSignature);
  const setProjectSavedSignature = useAppStore((s) => s.setProjectSavedSignature);
  const setIsExporting = useAppStore((s) => s.setIsExporting);
  const isExporting = useAppStore((s) => s.isExporting);
  const setExportProgressVisible = useAppStore((s) => s.setExportProgressVisible);
  const updateExportProgress = useAppStore((s) => s.updateExportProgress);
  const segments = useTimelineStore((s) => s.segments);
  const pushToast = useToastStore((s) => s.pushToast);
  const [isProjectDirty, setIsProjectDirty] = useState(false);
  const [dirtyReason, setDirtyReason] = useState<string>("project change");
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [lastAutosavedAt, setLastAutosavedAt] = useState<Date | null>(null);

  const formatSavedTime = (value: Date | null) => {
    if (!value) return null;
    return value.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const inferDirtyReason = (savedSignature: string, currentSignature: string) => {
    try {
      const saved = JSON.parse(savedSignature);
      const current = JSON.parse(currentSignature);

      if (JSON.stringify(saved.video?.overlays) !== JSON.stringify(current.video?.overlays)) {
        return "overlay edit";
      }
      if (JSON.stringify(saved.app?.game) !== JSON.stringify(current.app?.game)) {
        return "score change";
      }
      if (JSON.stringify(saved.app?.plays) !== JSON.stringify(current.app?.plays)) {
        return "timeline edit";
      }
      if (JSON.stringify(saved.timeline?.segments) !== JSON.stringify(current.timeline?.segments)) {
        return "timeline edit";
      }
      if (JSON.stringify(saved.video?.videoTrackKeyframes) !== JSON.stringify(current.video?.videoTrackKeyframes)) {
        return "video transform edit";
      }
      return "project change";
    } catch {
      return "project change";
    }
  };

  useEffect(() => {
    const ensureBaseline = () => {
      const current = ProjectService.getProjectSignature();
      if (!projectSavedSignature) {
        setProjectSavedSignature(current);
        setIsProjectDirty(false);
        setDirtyReason("project change");
      } else {
        const dirty = projectSavedSignature !== current;
        setIsProjectDirty(dirty);
        if (dirty) {
          setDirtyReason(inferDirtyReason(projectSavedSignature, current));
        }
      }
    };

    ensureBaseline();
    const timer = window.setInterval(ensureBaseline, 800);
    return () => window.clearInterval(timer);
  }, [projectSavedSignature, setProjectSavedSignature]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (!currentProjectPath || !isProjectDirty) return;
      try {
        await ProjectService.saveProject(currentProjectPath);
        setProjectSavedSignature(ProjectService.getProjectSignature());
        setLastAutosavedAt(new Date());
      } catch (error) {
        console.error("Auto-save failed", error);
      }
    }, 60_000);

    return () => window.clearInterval(timer);
  }, [currentProjectPath, isProjectDirty, setProjectSavedSignature]);

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

  const handleSaveProject = async () => {
    const targetPath = await save({
      defaultPath: "project.svp",
      filters: [{ name: "Sports Video Project", extensions: ["svp"] }],
    });

    if (!targetPath) return;
    const normalizedPath = targetPath.toLowerCase().endsWith(".svp")
      ? targetPath
      : `${targetPath}.svp`;

    try {
      await ProjectService.saveProject(normalizedPath);
      setCurrentProjectPath(normalizedPath);
      setProjectSavedSignature(ProjectService.getProjectSignature());
      setLastAutosavedAt(new Date());
      pushToast("Project saved", "success");
    } catch (error: any) {
      console.error(error);
      pushToast(`Save project failed: ${error?.message ?? error}`, "error");
    }
  };

  const handleLoadProject = async () => {
    const selection = await open({
      multiple: false,
      filters: [{ name: "Sports Video Project", extensions: ["svp"] }],
    });
    if (!selection) return;

    const projectPath = Array.isArray(selection) ? selection[0] : selection;
    if (typeof projectPath !== "string") return;

    try {
      await ProjectService.loadProject(projectPath);
      setCurrentProjectPath(projectPath);
      setProjectSavedSignature(ProjectService.getProjectSignature());
      setLastAutosavedAt(new Date());
      pushToast("Project loaded", "success");
    } catch (error: any) {
      console.error(error);
      pushToast(`Load project failed: ${error?.message ?? error}`, "error");
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
        onClick={handleLoadProject}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors"
      >
        Load Project
      </button>

      <button
        onClick={handleSaveProject}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors"
      >
        Save Project
      </button>

      <div className="w-px h-6 bg-panel-border" />

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

      <button
        onClick={() => setShowExportStatsModal(true)}
        disabled={plays.length === 0}
        className="px-3 py-1.5 bg-panel hover:bg-panel-border rounded text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Export Stats
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

        <span
          className={`text-[11px] uppercase tracking-wider ${
            isProjectDirty ? "text-amber-300" : "text-gray-500"
          }`}
          title={
            isProjectDirty
              ? `Unsaved: ${dirtyReason}`
              : lastAutosavedAt
                ? `All changes saved • Last autosave ${formatSavedTime(lastAutosavedAt)}`
                : "All changes saved"
          }
        >
          {isProjectDirty
            ? "● Unsaved Changes"
            : lastAutosavedAt
              ? `Saved • ${formatSavedTime(lastAutosavedAt)}`
              : "Saved"}
        </span>
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
