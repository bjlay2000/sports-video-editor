import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { useToastStore } from "../../store/toastStore";
import { DatabaseService } from "../../services/DatabaseService";
import { ProjectService } from "../../services/ProjectService";

interface SubstitutionModalProps {
  onClose: () => void;
}

export function SubstitutionModal({ onClose }: SubstitutionModalProps) {
  const players = useAppStore((s) => s.players);
  const onCourtPlayerIds = useAppStore((s) => s.onCourtPlayerIds);
  const setOnCourtStatusAtTime = useAppStore((s) => s.setOnCourtStatusAtTime);
  const bumpPlayedPercentRefresh = useAppStore((s) => s.bumpPlayedPercentRefresh);
  const currentTime = useVideoStore((s) => s.currentTime);
  const pushToast = useToastStore((s) => s.pushToast);

  const onCourtSet = useMemo(() => new Set(onCourtPlayerIds), [onCourtPlayerIds]);

  const sorted = useMemo(
    () => [...players].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name)),
    [players],
  );

  const onCourt = useMemo(() => sorted.filter((p) => onCourtSet.has(p.id)), [sorted, onCourtSet]);
  const bench = useMemo(() => sorted.filter((p) => !onCourtSet.has(p.id)), [sorted, onCourtSet]);

  const persistShifts = async () => {
    await ProjectService.ensureProjectDbOpen();
    const intervals = useAppStore.getState().onCourtIntervals;
    await DatabaseService.savePlayerShifts(
      intervals.map((iv) => ({
        player_id: iv.player_id,
        enter_time: iv.enter_time,
        exit_time: iv.exit_time,
      })),
    );
    bumpPlayedPercentRefresh();
  };

  const subOut = async (playerId: number) => {
    try {
      setOnCourtStatusAtTime(playerId, false, currentTime);
      await persistShifts();
    } catch (error) {
      console.error("Failed to save substitution", error);
      pushToast("Failed to save substitution", "error");
    }
  };

  const subIn = async (playerId: number) => {
    try {
      setOnCourtStatusAtTime(playerId, true, currentTime);
      await persistShifts();
    } catch (error) {
      console.error("Failed to save substitution", error);
      pushToast("Failed to save substitution", "error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface border border-panel-border rounded-lg shadow-xl w-[420px] max-h-[80vh] flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border">
          <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">
            Substitutions
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* body */}
        <div className="flex flex-1 overflow-hidden">
          {/* On Court column */}
          <div className="flex-1 border-r border-panel-border flex flex-col">
            <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-green-400 font-semibold bg-green-900/20">
              On Court ({onCourt.length})
            </div>
            <div className="flex-1 overflow-y-auto">
              {onCourt.length === 0 ? (
                <p className="text-xs text-gray-500 px-3 py-4">No players on court</p>
              ) : (
                onCourt.map((player) => (
                  <button
                    key={player.id}
                    type="button"
                    onClick={() => subOut(player.id)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-red-900/30 border-b border-white/5 transition-colors flex items-center justify-between"
                  >
                    <span>
                      <span className="text-gray-400 font-mono mr-2">#{player.number}</span>
                      {player.name}
                    </span>
                    <span className="text-[10px] text-red-400 uppercase">→ Bench</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Bench column */}
          <div className="flex-1 flex flex-col">
            <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-gray-400 font-semibold bg-panel/50">
              Bench ({bench.length})
            </div>
            <div className="flex-1 overflow-y-auto">
              {bench.length === 0 ? (
                <p className="text-xs text-gray-500 px-3 py-4">No players on bench</p>
              ) : (
                bench.map((player) => (
                  <button
                    key={player.id}
                    type="button"
                    onClick={() => subIn(player.id)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-green-900/30 border-b border-white/5 transition-colors flex items-center justify-between"
                  >
                    <span>
                      <span className="text-gray-400 font-mono mr-2">#{player.number}</span>
                      {player.name}
                    </span>
                    <span className="text-[10px] text-green-400 uppercase">→ Court</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="px-4 py-2 border-t border-panel-border flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 bg-panel hover:bg-panel-border rounded border border-panel-border text-gray-300 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
