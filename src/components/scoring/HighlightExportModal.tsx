import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { useToastStore } from "../../store/toastStore";
import { ExportService } from "../../services/ExportService";
import { StatType } from "../../store/types";
import { save } from "@tauri-apps/plugin-dialog";

const ALL_STAT_TYPES: StatType[] = [
  "2PT", "3PT", "FT", "AST", "REB", "STL", "BLK", "TO", "FOUL",
];

export function HighlightExportModal() {
  const [step, setStep] = useState<"players" | "stats">("players");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPlayers, setSelectedPlayers] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const setShowHighlightModal = useAppStore((s) => s.setShowHighlightModal);
  const players = useAppStore((s) => s.players);
  const plays = useAppStore((s) => s.plays);
  const setIsExporting = useAppStore((s) => s.setIsExporting);
  const setExportProgressVisible = useAppStore((s) => s.setExportProgressVisible);
  const updateExportProgress = useAppStore((s) => s.updateExportProgress);
  const videoPath = useVideoStore((s) => s.videoPath);
  const pushToast = useToastStore((s) => s.pushToast);

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
    if (selected.size === 0 || !videoPath) return;

    const types = Array.from(selected);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultPath = `highlights_${types.join("_")}_${timestamp}.mp4`;

    const savePath = await save({
      defaultPath,
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });

    if (!savePath) {
      return;
    }

    const normalizedPath = savePath.toLowerCase().endsWith(".mp4")
      ? savePath
      : `${savePath}.mp4`;

    setExporting(true);
    setIsExporting(true);
    setExportProgressVisible(true, "Exporting Highlights");
    try {
      const selectedPlayerIds = new Set(selectedPlayers);
      const clips = plays
        .filter((play) => selectedPlayerIds.has(play.player_id) && selected.has(play.event_type as StatType))
        .sort((a, b) => a.start_time - b.start_time)
        .map((p) => ({ start_time: p.start_time, end_time: p.end_time }));

      if (clips.length === 0) {
        pushToast("No clips found for selected stat types", "info");
        return;
      }

      await ExportService.exportHighlights(videoPath, clips, normalizedPath, {
        onProgress: (update) => {
          updateExportProgress(update.percent, update.status);
        },
      });
      pushToast("Highlight export complete", "success");
      setShowHighlightModal(false);
    } catch (e: any) {
      console.error(e);
      pushToast(`Export failed: ${e?.message ?? e}`, "error");
    } finally {
      setExporting(false);
      setIsExporting(false);
      setExportProgressVisible(false);
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
              disabled={selected.size === 0 || selectedPlayers.size === 0 || exporting}
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
