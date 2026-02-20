import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { DatabaseService } from "../../services/DatabaseService";

const SCORING_STATS = ["2PT", "3PT", "FT"];

const describeStat = (stat: string | null) => {
  if (!stat) return "";
  if (stat.endsWith("_MISS")) {
    return `${stat.replace("_MISS", "")} x`;
  }
  if (SCORING_STATS.includes(stat)) {
    return `${stat} +`;
  }
  return stat;
};

export function PlayerSelectModal() {
  const players = useAppStore((s) => s.players);
  const pendingStat = useAppStore((s) => s.pendingStat);
  const pendingStatTimestamp = useAppStore((s) => s.pendingStatTimestamp);
  const setShowPlayerModal = useAppStore((s) => s.setShowPlayerModal);
  const setPendingStat = useAppStore((s) => s.setPendingStat);
  const addPlay = useAppStore((s) => s.addPlay);
  const addMarker = useAppStore((s) => s.addMarker);
  const game = useAppStore((s) => s.game);
  const setGame = useAppStore((s) => s.setGame);
  const currentTime = useVideoStore((s) => s.currentTime);

  const handleSelect = async (playerId: number) => {
    if (!pendingStat) return;

    const captureTime = pendingStatTimestamp ?? currentTime;
    const startTime = Math.max(0, captureTime - 5);
    const endTime = captureTime + 2;

    try {
      const play = await DatabaseService.addPlay(
        captureTime,
        playerId,
        pendingStat,
        startTime,
        endTime
      );

      addPlay(play);
      addMarker({
        id: play.id,
        time: play.timestamp,
        event_type: play.event_type,
        player_name: play.player_name,
        start_time: play.start_time,
        end_time: play.end_time,
        label: play.event_type,
      });

      if (SCORING_STATS.includes(pendingStat)) {
        const points = pendingStat === "3PT" ? 3 : pendingStat === "2PT" ? 2 : 1;
        const newHome = game.home_score + points;
        const updated = await DatabaseService.updateScore(newHome, game.away_score);
        setGame(updated);
      }
    } catch (e) {
      console.error("Failed to add play:", e);
    }

    setPendingStat(null);
    setShowPlayerModal(false);
  };

  const handleClose = () => {
    setPendingStat(null);
    setShowPlayerModal(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-panel border border-panel-border rounded-lg p-5 w-80 max-h-96 overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-white">
            Select Player — {describeStat(pendingStat)}
          </h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ✕
          </button>
        </div>
        <div className="space-y-1.5">
          {players.map((player) => (
            <button
              key={player.id}
              onClick={() => handleSelect(player.id)}
              className="w-full text-left px-3 py-2 bg-surface hover:bg-surface-light rounded transition-colors flex items-center gap-3"
            >
              <span className="text-accent font-bold text-sm w-8">
                #{player.number}
              </span>
              <span className="text-white text-sm">{player.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
