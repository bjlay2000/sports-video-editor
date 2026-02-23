import { useEffect, useCallback, useState, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { useVideoStore } from "../store/videoStore";
import { useTimelineStore } from "../store/timelineStore";
import { useToastStore } from "../store/toastStore";
import { ExportService } from "../services/ExportService";
import {
  QUALITY_PROFILE_LABELS,
  QUALITY_PROFILE_OPTIONS,
  QUALITY_PRESETS,
  usesFastExportDimensions,
  detectHardwareEncoders,
  resolveEncoderSettings,
  type QualityProfile,
} from "../services/HardwareDetection";
import { getExportEstimate } from "../services/ExportEstimationService";
import { open, save } from "@tauri-apps/plugin-dialog";
import { MediaLibrary } from "../services/MediaLibrary";
import { PlayCoordinator } from "../services/PlayCoordinator";
import { ProjectService } from "../services/ProjectService";
import { logExportEvent } from "../services/ExportLogService";

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
  const setExportThumbnailUrl = useAppStore((s) => s.setExportThumbnailUrl);
  const setExportCurrentProcess = useAppStore((s) => s.setExportCurrentProcess);
  const setExportCompletionStats = useAppStore((s) => s.setExportCompletionStats);
  const exportQualityProfile = useAppStore((s) => s.exportQualityProfile);
  const setExportQualityProfile = useAppStore((s) => s.setExportQualityProfile);
  const initializeExportQualityForContext = useAppStore((s) => s.initializeExportQualityForContext);
  const exportEstimatedTime = useAppStore((s) => s.exportEstimatedTime);
  const setExportEstimatedTime = useAppStore((s) => s.setExportEstimatedTime);
  const videoWidth = useVideoStore((s) => s.videoWidth);
  const videoHeight = useVideoStore((s) => s.videoHeight);
  const segments = useTimelineStore((s) => s.segments);
  const pushToast = useToastStore((s) => s.pushToast);
  const [isProjectDirty, setIsProjectDirty] = useState(false);
  const [dirtyReason, setDirtyReason] = useState<string>("project change");
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [lastAutosavedAt, setLastAutosavedAt] = useState<Date | null>(null);

  // ── Export time estimation ──
  // Recalculates when quality preset, duration, or video dimensions change.
  const estimationVersion = useRef(0);
  useEffect(() => {
    const version = ++estimationVersion.current;
    const totalDuration = segments.length
      ? segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
      : duration;

    if (totalDuration <= 0 || videoWidth <= 0 || videoHeight <= 0) {
      setExportEstimatedTime(null);
      return;
    }

    // Async: detect hardware, resolve encoder, estimate
    (async () => {
      try {
        const caps = await detectHardwareEncoders();
        if (version !== estimationVersion.current) return; // stale

        const isFastDims = usesFastExportDimensions(exportQualityProfile);
        const expW = isFastDims ? Math.min(videoWidth, 1920) : videoWidth;
        const expH = isFastDims
          ? Math.min(videoHeight, Math.round(expW * (videoHeight / videoWidth)))
          : videoHeight;
        // Ensure even dimensions
        const exportW = Math.max(2, Math.floor(expW / 2) * 2);
        const exportH = Math.max(2, Math.floor(expH / 2) * 2);

        const settings = resolveEncoderSettings(exportQualityProfile, caps.vendor, {
          availableHw: caps.availableHw,
          availableSw: caps.availableSw,
        });

        const { display } = getExportEstimate({
          preset: exportQualityProfile,
          vendor: caps.vendor,
          encoder: settings.encoder,
          totalDurationSec: totalDuration,
          exportWidth: exportW,
          exportHeight: exportH,
          fps: 30,
        });

        if (version === estimationVersion.current) {
          setExportEstimatedTime(display);
        }
      } catch {
        if (version === estimationVersion.current) {
          setExportEstimatedTime(null);
        }
      }
    })();
  }, [exportQualityProfile, duration, segments, videoWidth, videoHeight, setExportEstimatedTime]);

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
    logExportEvent("Toolbar", "handleExportFull: click");
    initializeExportQualityForContext("full");
    if (!videoPath) {
      logExportEvent("Toolbar", "handleExportFull: aborted (no videoPath)");
      return;
    }
    const usableSegments = segments.length
      ? segments.filter((segment) => segment.end > segment.start)
      : duration > 0
        ? [{ start: 0, end: duration }]
        : [];
    if (usableSegments.length === 0) {
      logExportEvent("Toolbar", "handleExportFull: aborted (no usable segments)");
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
      logExportEvent("Toolbar", "handleExportFull: user cancelled save dialog");
      return;
    }

    const normalizedPath = targetPath.toLowerCase().endsWith(".mp4")
      ? targetPath
      : `${targetPath}.mp4`;

    setIsExporting(true);
    logExportEvent("Toolbar", `handleExportFull: export start output=${normalizedPath}`);
    // Capture thumbnail from video element
    const videoEl = document.querySelector("video");
    if (videoEl) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = videoEl.videoWidth || 640;
        canvas.height = videoEl.videoHeight || 360;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        setExportThumbnailUrl(canvas.toDataURL("image/jpeg", 0.7));
      } catch { /* ignore cross-origin or empty video */ }
    }
    setExportProgressVisible(true, "Exporting Full Video");
    let completed = false;
    try {
      const result = await ExportService.exportFull(videoPath, clips, normalizedPath, {
        onProgress: (update) => {
          logExportEvent(
            "Toolbar",
            `handleExportFull:onProgress percent=${update.percent.toFixed(2)} status=${update.status ?? ""}`,
          );
          updateExportProgress(update.percent, update.status);
        },
        onProcessChange: (process) => {
          logExportEvent("Toolbar", `handleExportFull:onProcessChange ${process}`);
          setExportCurrentProcess(process);
        },
      });
      setExportCompletionStats({
        outputPath: result.outputPath,
        outputSizeBytes: result.outputSizeBytes,
        totalElapsedMs: result.totalElapsedMs,
        encodeElapsedMs: result.encodeElapsedMs,
        encoder: result.encoder,
        encoderDisplay: result.encoderDisplay,
        vendorDisplay: result.vendorDisplay,
        exportWidth: result.exportWidth,
        exportHeight: result.exportHeight,
        totalDurationSec: result.totalDurationSec,
        totalFrames: result.totalFrames,
        fps: result.fps,
      });
      completed = true;
      logExportEvent("Toolbar", "handleExportFull: export complete");
      pushToast("Export complete", "success");
    } catch (e: any) {
      console.error(e);
      const message = String(e?.message ?? e ?? "");
      logExportEvent("Toolbar", `handleExportFull: export error ${message}`);
      if (message.toLowerCase().includes("cancelled")) {
        pushToast("Export cancelled", "info");
      } else {
        pushToast(`Export failed: ${message}`, "error");
      }
    } finally {
      logExportEvent("Toolbar", "handleExportFull: cleanup/finalize");
      setIsExporting(false);
      if (!completed) {
        setExportCompletionStats(null);
        setExportProgressVisible(false);
      }
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
    initializeExportQualityForContext("highlights");
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

      <label className="flex items-center gap-2 text-xs text-gray-400 ml-1">
        <span>Quality</span>
        <select
          value={exportQualityProfile}
          onChange={(e) => setExportQualityProfile(e.target.value as QualityProfile, "user")}
          className="px-2 py-1 bg-panel border border-panel-border rounded text-xs text-white"
          title="Export quality profile"
        >
          {QUALITY_PROFILE_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {QUALITY_PROFILE_LABELS[value]}
            </option>
          ))}
        </select>
        {exportEstimatedTime && !isExporting && (
          <span className="text-[11px] text-gray-500" title="Estimated export time">
            {exportEstimatedTime}
          </span>
        )}
      </label>

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
