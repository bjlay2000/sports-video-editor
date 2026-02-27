import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { DatabaseService } from "../../services/DatabaseService";
import { PlayCoordinator } from "../../services/PlayCoordinator";
import { ProjectService } from "../../services/ProjectService";

export function AddPlayerModal() {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const setShowAddPlayerModal = useAppStore((s) => s.setShowAddPlayerModal);
  const players = useAppStore((s) => s.players);
  const plays = useAppStore((s) => s.plays);
  const setPlayers = useAppStore((s) => s.setPlayers);

  const handleAdd = async () => {
    const num = parseInt(number, 10);
    if (!name.trim() || isNaN(num)) return;
    try {
      await ProjectService.ensureProjectDbOpen();
      await DatabaseService.addPlayer(name.trim(), num);
      const refreshedPlayers = await DatabaseService.getPlayers();
      setPlayers(refreshedPlayers);
      setName("");
      setNumber("");
    } catch (e) {
      console.error("Failed to add player:", e);
      window.alert("Could not add player. Please try again.");
    }
  };

  const handleDelete = async (id: number) => {
    const player = players.find((p) => p.id === id);
    const playerPlays = plays.filter((play) => play.player_id === id);
    const label = player ? `#${player.number} ${player.name}` : "this player";
    const confirmed = window.confirm(
      playerPlays.length > 0
        ? `Delete ${label} and remove ${playerPlays.length} recorded plays?`
        : `Delete ${label}?`
    );
    if (!confirmed) return;
    try {
      await ProjectService.ensureProjectDbOpen();
      if (playerPlays.length > 0) {
        await PlayCoordinator.removePlays(playerPlays.map((play) => play.id));
      }
      await DatabaseService.deletePlayer(id);
      const refreshedPlayers = await DatabaseService.getPlayers();
      setPlayers(refreshedPlayers);
    } catch (e) {
      console.error("Failed to delete player:", e);
      window.alert("Could not delete player. Please try again.");
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-panel border border-panel-border rounded-lg p-5 w-96">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-white">Manage Players</h2>
          <button
            onClick={() => setShowAddPlayerModal(false)}
            className="text-gray-400 hover:text-white text-xl"
          >
            ✕
          </button>
        </div>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 px-3 py-1.5 bg-surface border border-panel-border rounded text-sm text-white placeholder-gray-500 outline-none focus:border-accent"
          />
          <input
            type="number"
            placeholder="#"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className="w-16 px-3 py-1.5 bg-surface border border-panel-border rounded text-sm text-white placeholder-gray-500 outline-none focus:border-accent"
          />
          <button
            onClick={handleAdd}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded text-sm transition-colors"
          >
            Add
          </button>
        </div>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {players.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between px-3 py-1.5 bg-surface rounded"
            >
              <span className="text-sm text-white">
                <span className="text-accent font-bold mr-2">#{p.number}</span>
                {p.name}
              </span>
              <button
                onClick={() => handleDelete(p.id)}
                className="text-gray-500 hover:text-red-400 text-sm transition-colors"
              >
                ✕
              </button>
            </div>
          ))}
          {players.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-2">
              No players added yet
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
