import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";

function csvEscape(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function ExportStatsModal() {
  const players = useAppStore((s) => s.players);
  const plays = useAppStore((s) => s.plays);
  const game = useAppStore((s) => s.game);
  const setShowExportStatsModal = useAppStore((s) => s.setShowExportStatsModal);
  const pushToast = useToastStore((s) => s.pushToast);

  const [selectedPlayerIds, setSelectedPlayerIds] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);

  const sortedPlayers = useMemo(
    () => [...players].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name)),
    [players],
  );

  const allSelected = sortedPlayers.length > 0 && selectedPlayerIds.size === sortedPlayers.length;

  const toggleAll = (checked: boolean) => {
    if (checked) {
      setSelectedPlayerIds(new Set(sortedPlayers.map((p) => p.id)));
      return;
    }
    setSelectedPlayerIds(new Set());
  };

  const togglePlayer = (playerId: number) => {
    const next = new Set(selectedPlayerIds);
    if (next.has(playerId)) {
      next.delete(playerId);
    } else {
      next.add(playerId);
    }
    setSelectedPlayerIds(next);
  };

  const handleExport = async () => {
    if (selectedPlayerIds.size === 0) {
      pushToast("Select at least one player", "info");
      return;
    }

    const selected = new Set(selectedPlayerIds);
    const filteredPlays = plays
      .filter((p) => selected.has(p.player_id))
      .sort((a, b) => a.timestamp - b.timestamp);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const savePath = await save({
      defaultPath: `stats_export_${timestamp}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (!savePath) {
      return;
    }

    const normalizedPath = savePath.toLowerCase().endsWith(".csv") ? savePath : `${savePath}.csv`;

    const rows: string[] = [];
    rows.push("meta_key,meta_value");
    rows.push(`home_score,${csvEscape(game.home_score)}`);
    rows.push(`away_score,${csvEscape(game.away_score)}`);
    rows.push(`exported_at,${csvEscape(new Date().toISOString())}`);
    rows.push("");
    rows.push("play_id,timestamp,start_time,end_time,event_type,player_id,player_number,player_name");

    for (const play of filteredPlays) {
      rows.push([
        csvEscape(play.id),
        csvEscape(play.timestamp),
        csvEscape(play.start_time),
        csvEscape(play.end_time),
        csvEscape(play.event_type),
        csvEscape(play.player_id),
        csvEscape(play.player_number ?? ""),
        csvEscape(play.player_name ?? ""),
      ].join(","));
    }

    try {
      setExporting(true);
      const data = new TextEncoder().encode(rows.join("\n"));
      await writeFile(normalizedPath, data);
      pushToast("Stats export complete", "success");
      setShowExportStatsModal(false);
    } catch (error: any) {
      console.error(error);
      pushToast(`Stats export failed: ${error?.message ?? error}`, "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-panel border border-panel-border rounded-lg p-5 w-96 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Export Stats</h2>
          <button
            onClick={() => setShowExportStatsModal(false)}
            className="text-gray-400 hover:text-white text-xl"
          >
            ✕
          </button>
        </div>

        <label className="flex items-center justify-between px-3 py-2 mb-2 rounded bg-surface border border-panel-border">
          <span className="text-sm text-white">Select All Players</span>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => toggleAll(e.target.checked)}
            className="accent-accent"
          />
        </label>

        <div className="space-y-1.5 mb-4 max-h-64 overflow-y-auto">
          {sortedPlayers.map((player) => (
            <label
              key={player.id}
              className="flex items-center justify-between gap-2 px-3 py-2 bg-surface rounded border border-panel-border"
            >
              <span className="text-sm text-white">
                <span className="text-accent font-semibold mr-2">#{player.number}</span>
                {player.name}
              </span>
              <input
                type="checkbox"
                checked={selectedPlayerIds.has(player.id)}
                onChange={() => togglePlayer(player.id)}
                className="accent-accent"
              />
            </label>
          ))}
          {sortedPlayers.length === 0 && (
            <p className="text-xs text-gray-500">No players available.</p>
          )}
        </div>

        <button
          onClick={handleExport}
          disabled={exporting || selectedPlayerIds.size === 0}
          className="w-full py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {exporting ? "Exporting..." : "Export CSV"}
        </button>
      </div>
    </div>
  );
}
