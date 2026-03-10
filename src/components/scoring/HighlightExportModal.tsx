import { useEffect, useRef, useCallback, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { useToastStore } from "../../store/toastStore";
import { ExportService } from "../../services/ExportService";
import { logExportEvent } from "../../services/ExportLogService";
import { StatType } from "../../store/types";
import { save } from "@tauri-apps/plugin-dialog";
import { getRenderState } from "../../engine/RenderEngine";
import { renderFrame } from "../../engine/CanvasCompositor";
import { deriveScoreEvents } from "../../engine/scoreEvents";
import type { TimelineModel } from "../../engine/types";

const ALL_STAT_TYPES: StatType[] = [
  "2PT", "3PT", "FT", "AST", "REB", "STL", "BLK", "TO", "FOUL",
];

export function HighlightExportModal() {
  const [step, setStep] = useState<"players" | "stats">("players");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPlayers, setSelectedPlayers] = useState<Set<number>>(new Set());
  const [includeManualHighlights, setIncludeManualHighlights] = useState(false);
  const [exporting, setExporting] = useState(false);
  const setShowHighlightModal = useAppStore((s) => s.setShowHighlightModal);
  const players = useAppStore((s) => s.players);
  const plays = useAppStore((s) => s.plays);
  const markers = useAppStore((s) => s.markers);
  const setIsExporting = useAppStore((s) => s.setIsExporting);
  const setExportProgressVisible = useAppStore((s) => s.setExportProgressVisible);
  const updateExportProgress = useAppStore((s) => s.updateExportProgress);
  const setExportThumbnailUrl = useAppStore((s) => s.setExportThumbnailUrl);
  const setExportCurrentProcess = useAppStore((s) => s.setExportCurrentProcess);
  const setExportCompletionStats = useAppStore((s) => s.setExportCompletionStats);
  const initializeExportQualityForContext = useAppStore((s) => s.initializeExportQualityForContext);
  const videoPath = useVideoStore((s) => s.videoPath);
  const pushToast = useToastStore((s) => s.pushToast);
  const exportThumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const exportThumbStateRef = useRef({ lastUpdateAt: 0, lastFrame: 0 });
  const estimatedSystemLoadRef = useRef(0);

  useEffect(() => {
    let prevTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const driftMs = Math.max(0, now - prevTick - 1000);
      prevTick = now;
      estimatedSystemLoadRef.current = Math.min(100, (driftMs / 150) * 100);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const tryUpdateExportThumbnail = useCallback(async (status?: string, seekTime?: number) => {
    const frameMatch = status?.match(/\((\d+)\/(\d+)\)/);
    const frame = frameMatch ? Number.parseInt(frameMatch[1], 10) : NaN;
    const now = Date.now();
    const state = exportThumbStateRef.current;
    if (estimatedSystemLoadRef.current > 85) return;
    if (now - state.lastUpdateAt < 1000) return;
    if (Number.isFinite(frame) && frame > 0 && frame - state.lastFrame < 60) return;

    const videoEl = document.querySelector("video") as HTMLVideoElement | null;
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return;

    // Seek to segment preview position (4s mark or midpoint)
    if (seekTime !== undefined && Number.isFinite(seekTime) && seekTime >= 0) {
      videoEl.currentTime = seekTime;
      await new Promise<void>((resolve) => {
        const onSeeked = () => { videoEl.removeEventListener("seeked", onSeeked); resolve(); };
        videoEl.addEventListener("seeked", onSeeked);
        setTimeout(() => { videoEl.removeEventListener("seeked", onSeeked); resolve(); }, 500);
      });
    }

    if (!exportThumbCanvasRef.current) {
      exportThumbCanvasRef.current = document.createElement("canvas");
    }
    const canvas = exportThumbCanvasRef.current;
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(async () => {
        try {
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

          // Render overlays on top if scoreboard overlay is enabled
          const videoState = useVideoStore.getState();
          if (videoState.showScoreboardOverlay) {
            const appState = useAppStore.getState();
            const overlayList = videoState.overlays ?? [];
            const scoreEvts = deriveScoreEvents(
              appState.plays,
              appState.opponentScoreEvents,
              appState.homeScoreEvents,
            );
            const model: TimelineModel = {
              duration: videoState.duration || 0,
              currentTime: videoEl.currentTime,
              overlays: overlayList,
              scoreEvents: scoreEvts,
              videoTrack: { keyframes: [{ time: 0, scale: 1, x: 0, y: 0 }] },
            };
            const rs = getRenderState(model, videoEl.currentTime);
            await renderFrame(ctx, rs, canvas.width, canvas.height);
          }

          setExportThumbnailUrl(canvas.toDataURL("image/jpeg", 0.65));
          state.lastUpdateAt = now;
          if (Number.isFinite(frame) && frame > 0) {
            state.lastFrame = frame;
          }
        } catch {
          // ignore
        }
        resolve();
      });
    });
  }, [setExportThumbnailUrl]);

  useEffect(() => {
    initializeExportQualityForContext("highlights");
  }, [initializeExportQualityForContext]);

  const allSelected = selected.size === ALL_STAT_TYPES.length;
  const allPlayersSelected = players.length > 0 && selectedPlayers.size === players.length;

  const toggle = (type: string) => {
    const next = new Set(selected);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setSelected(next);
  };

  const toggleAll = (checked: boolean) => {
    if (checked) {
      setSelected(new Set(ALL_STAT_TYPES));
      return;
    }
    setSelected(new Set());
  };

  const togglePlayer = (playerId: number) => {
    const next = new Set(selectedPlayers);
    if (next.has(playerId)) next.delete(playerId);
    else next.add(playerId);
    setSelectedPlayers(next);
  };

  const toggleAllPlayers = (checked: boolean) => {
    if (checked) {
      setSelectedPlayers(new Set(players.map((p) => p.id)));
      return;
    }
    setSelectedPlayers(new Set());
  };

  const handleExport = async () => {
    logExportEvent("HighlightExportModal", "handleExport: click");
    if ((selected.size === 0 && !includeManualHighlights) || !videoPath) {
      logExportEvent("HighlightExportModal", "handleExport: aborted (no selected stats or videoPath)");
      return;
    }

    const types = Array.from(selected);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultPath = `highlights_${types.join("_")}_${timestamp}.mp4`;

    const savePath = await save({
      defaultPath,
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });

    if (!savePath) {
      logExportEvent("HighlightExportModal", "handleExport: user cancelled save dialog");
      return;
    }

    const normalizedPath = savePath.toLowerCase().endsWith(".mp4")
      ? savePath
      : `${savePath}.mp4`;

    setExporting(true);
    exportThumbStateRef.current = { lastUpdateAt: 0, lastFrame: 0 };
    setIsExporting(true);
    logExportEvent("HighlightExportModal", `handleExport: export start output=${normalizedPath}`);
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
    setExportProgressVisible(true, "Exporting Highlights");
    let completed = false;
    try {
      const STAT_LABEL_MAP: Record<string, string> = {
        "2PT": "2pt",
        "3PT": "3pt",
        "FT": "FT",
        "REB": "REB",
        "AST": "AST",
        "STL": "STL",
        "BLK": "BLK",
      };

      const selectedPlayerIds = new Set(selectedPlayers);
      const statClips = plays
        .filter((play) => selectedPlayerIds.has(play.player_id) && selected.has(play.event_type as StatType))
        .sort((a, b) => a.start_time - b.start_time)
        .map((p) => ({
          start_time: p.start_time,
          end_time: p.end_time,
          label: STAT_LABEL_MAP[p.event_type] ?? "",
        }));

      const manualClips = includeManualHighlights
        ? markers
            .filter((m) => m.event_type === "HIGHLIGHT" && typeof m.start_time === "number" && typeof m.end_time === "number")
            .sort((a, b) => a.start_time! - b.start_time!)
            .map((m) => ({ start_time: m.start_time!, end_time: m.end_time!, label: "" }))
        : [];

      const clips = [...statClips, ...manualClips].sort((a, b) => a.start_time - b.start_time);

      if (clips.length === 0) {
        logExportEvent("HighlightExportModal", "handleExport: aborted (no clips matched filters)");
        pushToast("No clips found for selected stat types", "info");
        return;
      }

      // Precompute 4s-mark (or midpoint) seek times for each segment preview
      const segmentPreviewTimes = clips.map((clip) => {
        const clipDuration = clip.end_time - clip.start_time;
        const previewOffset = Math.min(4, clipDuration / 2);
        return clip.start_time + previewOffset;
      });
      const totalHighlightDuration = clips.reduce(
        (sum, clip) => sum + (clip.end_time - clip.start_time),
        0,
      );
      let lastSegmentIdx = -1;

      const result = await ExportService.exportHighlights(videoPath, clips, normalizedPath, {
        onProgress: (update) => {
          logExportEvent(
            "HighlightExportModal",
            `handleExport:onProgress percent=${update.percent.toFixed(2)} status=${update.status ?? ""}`,
          );
          updateExportProgress(update.percent, update.status);

          // Determine current segment from progress %
          // Highlight progress: 5 + (encodedDuration / totalDuration) * 89
          const encodedPortion = Math.max(0, update.percent - 5) / 89;
          const encodedDuration = encodedPortion * totalHighlightDuration;
          let elapsed = 0;
          let segmentIdx = 0;
          for (let i = 0; i < clips.length; i++) {
            elapsed += clips[i].end_time - clips[i].start_time;
            if (encodedDuration <= elapsed) {
              segmentIdx = i;
              break;
            }
            segmentIdx = i;
          }

          // Update thumbnail when entering a new segment (4s preview frame)
          const seekTime =
            segmentIdx !== lastSegmentIdx
              ? segmentPreviewTimes[segmentIdx]
              : undefined;
          if (segmentIdx !== lastSegmentIdx) {
            lastSegmentIdx = segmentIdx;
          }
          void tryUpdateExportThumbnail(update.status, seekTime);
        },
        onProcessChange: (process) => {
          logExportEvent("HighlightExportModal", `handleExport:onProcessChange ${process}`);
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
      logExportEvent("HighlightExportModal", "handleExport: export complete");
      pushToast("Highlight export complete", "success");
      setShowHighlightModal(false);
    } catch (e: any) {
      console.error(e);
      const message = String(e?.message ?? e ?? "");
      logExportEvent("HighlightExportModal", `handleExport: export error ${message}`);
      if (message.toLowerCase().includes("cancelled")) {
        pushToast("Export cancelled", "info");
      } else {
        pushToast(`Export failed: ${message}`, "error");
      }
    } finally {
      logExportEvent("HighlightExportModal", "handleExport: cleanup/finalize");
      setExporting(false);
      setIsExporting(false);
      if (!completed) {
        setExportCompletionStats(null);
        setExportProgressVisible(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-panel border border-panel-border rounded-lg p-5 w-80">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-white">Export Highlights</h2>
          <button
            onClick={() => setShowHighlightModal(false)}
            className="text-gray-400 hover:text-white text-xl"
          >
            ✕
          </button>
        </div>
        {step === "players" ? (
          <>
            <p className="text-xs text-gray-400 mb-3">Select players to include:</p>
            <label className="flex items-center justify-between px-3 py-1.5 bg-surface rounded border border-panel-border mb-2">
              <span className="text-sm text-white">Select All Players</span>
              <input
                type="checkbox"
                checked={allPlayersSelected}
                onChange={(e) => toggleAllPlayers(e.target.checked)}
                className="accent-accent"
              />
            </label>
            <div className="space-y-1.5 mb-4 max-h-56 overflow-y-auto pr-1">
              {players
                .slice()
                .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name))
                .map((player) => (
                  <label
                    key={player.id}
                    className="flex items-center justify-between gap-2 px-3 py-1.5 bg-surface rounded cursor-pointer hover:bg-surface-light transition-colors"
                  >
                    <span className="text-sm text-white">
                      <span className="text-accent font-semibold mr-2">#{player.number}</span>
                      {player.name}
                    </span>
                    <input
                      type="checkbox"
                      checked={selectedPlayers.has(player.id)}
                      onChange={() => togglePlayer(player.id)}
                      className="accent-accent"
                    />
                  </label>
                ))}
            </div>
            <button
              onClick={() => setStep("stats")}
              disabled={selectedPlayers.size === 0}
              className="w-full py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next: Select Stats
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-400 mb-3">Select stat types to include:</p>
            <label className="flex items-center justify-between px-3 py-1.5 bg-surface rounded border border-panel-border mb-2">
              <span className="text-sm text-white">Select All</span>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) => toggleAll(e.target.checked)}
                className="accent-accent"
              />
            </label>
            <div className="space-y-1.5 mb-4">
              {ALL_STAT_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex items-center gap-2 px-3 py-1.5 bg-surface rounded cursor-pointer hover:bg-surface-light transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(type)}
                    onChange={() => toggle(type)}
                    className="accent-accent"
                  />
                  <span className="text-sm text-white">{type}</span>
                </label>
              ))}
            </div>
            <label className="flex items-center justify-between px-3 py-1.5 bg-surface rounded border border-panel-border mb-4 cursor-pointer hover:bg-surface-light transition-colors">
              <span className="text-sm text-white">Manual Highlights</span>
              <input
                type="checkbox"
                checked={includeManualHighlights}
                onChange={() => setIncludeManualHighlights((prev) => !prev)}
                className="accent-accent"
              />
            </label>
            <label
              className="flex items-center justify-between text-xs text-gray-400 mb-3"
            >
              <button
                type="button"
                onClick={() => setStep("players")}
                className="text-gray-300 hover:text-white transition-colors"
              >
                ← Back to Players
              </button>
              <span>{selectedPlayers.size} player(s) selected</span>
            </label>
            <button
              onClick={handleExport}
              disabled={(selected.size === 0 && !includeManualHighlights) || (selected.size > 0 && selectedPlayers.size === 0) || exporting}
              className="w-full py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {exporting ? "Exporting..." : "Export Selected"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
