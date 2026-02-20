import { useCallback, useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { StatType } from "../../store/types";
import { PlayCoordinator } from "../../services/PlayCoordinator";
import { DatabaseService } from "../../services/DatabaseService";
import { useTimelineStore } from "../../store/timelineStore";
import { videoEngine } from "../../services/VideoEngine";

type ShotKey = "2PT" | "3PT" | "FT";

const SHOT_TYPES: Array<{
  key: ShotKey;
  label: string;
  makeType: StatType;
  missType: StatType;
  colorMake: string;
  colorMiss: string;
  points: number;
}> = [
  {
    key: "2PT",
    label: "2PT",
    makeType: "2PT",
    missType: "2PT_MISS",
    colorMake: "bg-green-700 hover:bg-green-600",
    colorMiss: "bg-gray-800 hover:bg-gray-700",
    points: 2,
  },
  {
    key: "3PT",
    label: "3PT",
    makeType: "3PT",
    missType: "3PT_MISS",
    colorMake: "bg-green-800 hover:bg-green-700",
    colorMiss: "bg-gray-800 hover:bg-gray-700",
    points: 3,
  },
  {
    key: "FT",
    label: "FT",
    makeType: "FT",
    missType: "FT_MISS",
    colorMake: "bg-green-900 hover:bg-green-800",
    colorMiss: "bg-gray-800 hover:bg-gray-700",
    points: 1,
  },
];

const OTHER_STATS = ["AST", "REB", "STL", "BLK", "TO", "FOUL"] as const;
type OtherStat = (typeof OTHER_STATS)[number];

const SHOT_POINT_MAP = SHOT_TYPES.reduce<Record<ShotKey, number>>((acc, shot) => {
  acc[shot.key] = shot.points;
  return acc;
}, { "2PT": 2, "3PT": 3, "FT": 1 });

const SCORING_TYPES = new Set<StatType>(SHOT_TYPES.map((shot) => shot.makeType));

const SKILL_BUTTONS: { label: string; type: StatType; color: string }[] = [
  { label: "Assist", type: "AST", color: "bg-blue-700 hover:bg-blue-600" },
  { label: "Rebound", type: "REB", color: "bg-yellow-700 hover:bg-yellow-600" },
  { label: "Steal", type: "STL", color: "bg-purple-700 hover:bg-purple-600" },
  { label: "Block", type: "BLK", color: "bg-red-700 hover:bg-red-600" },
  { label: "Turnover", type: "TO", color: "bg-orange-700 hover:bg-orange-600" },
  { label: "Foul", type: "FOUL", color: "bg-rose-800 hover:bg-rose-700" },
];

const createEmptyShotTotals = () =>
  SHOT_TYPES.reduce(
    (acc, shot) => ({
      ...acc,
      [shot.key]: { makes: 0, misses: 0 },
    }),
    {} as Record<ShotKey, { makes: number; misses: number }>
  );

const createEmptyOtherTotals = () =>
  OTHER_STATS.reduce(
    (acc, stat) => ({
      ...acc,
      [stat]: 0,
    }),
    {} as Record<OtherStat, number>
  );

const formatEventLabel = (eventType: string) => {
  const shotMatch = SHOT_TYPES.find(
    (shot) => eventType === shot.makeType || eventType === shot.missType
  );
  if (shotMatch) {
    return `${shotMatch.label} ${eventType === shotMatch.makeType ? "+" : "x"}`;
  }
  return eventType;
};

export function ScoringPanel() {
  const game = useAppStore((s) => s.game);
  const plays = useAppStore((s) => s.plays);
  const players = useAppStore((s) => s.players);
  const setPendingStat = useAppStore((s) => s.setPendingStat);
  const setShowPlayerModal = useAppStore((s) => s.setShowPlayerModal);
  const setShowAddPlayerModal = useAppStore((s) => s.setShowAddPlayerModal);
  const setGame = useAppStore((s) => s.setGame);
  const opponentScoreEvents = useAppStore((s) => s.opponentScoreEvents);
  const logOpponentScoreEvent = useAppStore((s) => s.logOpponentScoreEvent);
  const videoSrc = useVideoStore((s) => s.videoSrc);
  const currentTime = useVideoStore((s) => s.currentTime);
  const setVideoTime = useVideoStore((s) => s.setCurrentTime);
  const showScoreboardOverlay = useVideoStore((s) => s.showScoreboardOverlay);
  const toggleScoreboardOverlay = useVideoStore((s) => s.toggleScoreboardOverlay);
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime);
  const [showStatsDrawer, setShowStatsDrawer] = useState(false);

  const handleStatClick = (statType: StatType) => {
    if (!videoSrc) return;
    if (players.length === 0) {
      alert("Add players first!");
      return;
    }
    setPendingStat(statType, currentTime);
    setShowPlayerModal(true);
  };

  const adjustOpponentScore = async (delta: number) => {
    const nextAway = Math.max(0, game.away_score + delta);
    if (nextAway === game.away_score) return;
    const updated = await DatabaseService.updateScore(game.home_score, nextAway);
    setGame(updated);
    logOpponentScoreEvent(nextAway, currentTime);
  };

  const recentPlays = [...plays]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8);

  const handleDeletePlay = async (id: number) => {
    await PlayCoordinator.removePlays([id]);
  };

  const jumpToPlayStart = useCallback(
    (start: number) => {
      if (!videoSrc) return;
      const target = Math.max(0, start);
      videoEngine.seek(target);
      setVideoTime(target);
      setPlayheadTime(target);
    },
    [setPlayheadTime, setVideoTime, videoSrc]
  );

  const { statRows, teamTotals } = useMemo(() => {
    const rows = players.map((player) => {
      const shots = createEmptyShotTotals();
      const others = createEmptyOtherTotals();
      plays.forEach((play) => {
        if (play.player_id !== player.id) return;
        const shotMatch = SHOT_TYPES.find(
          (shot) => play.event_type === shot.makeType || play.event_type === shot.missType
        );
        if (shotMatch) {
          if (play.event_type === shotMatch.makeType) {
            shots[shotMatch.key].makes += 1;
          } else {
            shots[shotMatch.key].misses += 1;
          }
          return;
        }
        const statKey = play.event_type as StatType;
        if ((OTHER_STATS as readonly StatType[]).includes(statKey)) {
          const key = statKey as OtherStat;
          others[key] += 1;
        }
      });
      const points = SHOT_TYPES.reduce(
        (sum, shot) => sum + shots[shot.key].makes * shot.points,
        0
      );
      return { player, shots, others, points };
    });

    const totals = rows.reduce(
      (acc, row) => {
        SHOT_TYPES.forEach((shot) => {
          acc.shots[shot.key].makes += row.shots[shot.key].makes;
          acc.shots[shot.key].misses += row.shots[shot.key].misses;
        });
        OTHER_STATS.forEach((stat) => {
          acc.others[stat] += row.others[stat];
        });
        acc.points += row.points;
        return acc;
      },
      { shots: createEmptyShotTotals(), others: createEmptyOtherTotals(), points: 0 }
    );

    return { statRows: rows, teamTotals: totals };
  }, [players, plays]);

  return (
    <div className="h-full flex flex-col bg-panel overflow-hidden">
      <div className="p-3 border-b border-panel-border">
        <div className="flex flex-wrap items-center justify-between mb-3 gap-3">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
              Scoreboard
            </h2>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] text-gray-500">
              <span>Overlays</span>
              <button
                type="button"
                role="switch"
                aria-checked={showScoreboardOverlay}
                onClick={() => toggleScoreboardOverlay(!showScoreboardOverlay)}
                className={`relative h-4 w-8 rounded-full border border-panel-border transition-colors ${
                  showScoreboardOverlay ? "bg-accent/80" : "bg-panel"
                }`}
              >
                <span
                  className={`absolute top-1/2 left-1 h-3 w-3 -translate-y-1/2 rounded-full bg-white transition-transform ${
                    showScoreboardOverlay ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setShowAddPlayerModal(true)}
              className="text-xs px-2 py-1 bg-accent hover:bg-accent-hover rounded transition-colors"
            >
              + Player
            </button>
            <button
              onClick={() => setShowStatsDrawer((prev) => !prev)}
              className="text-xs px-2 py-1 bg-panel hover:bg-panel-border rounded transition-colors text-gray-200"
            >
              {showStatsDrawer ? "Hide Stats" : "Game Stats"}
            </button>
          </div>
        </div>
        <div className="relative">
          <div className="flex justify-center gap-8 py-2">
          <div className="text-center">
            <div className="text-3xl font-bold text-white">{game.home_score}</div>
            <div className="text-xs text-gray-400 mt-1">HOME</div>
          </div>
          <div className="text-2xl text-gray-500 self-center">—</div>
          <div className="text-center">
            <div className="text-3xl font-bold text-white">{game.away_score}</div>
            <div className="text-xs text-gray-400 mt-1">AWAY</div>
          </div>
        </div>
          <div className="mt-3 flex justify-end">
            <div className="flex flex-col items-end gap-1 text-[11px] text-gray-400 uppercase tracking-wider">
              <span>Opponent Score</span>
              <div className="flex overflow-hidden rounded border border-panel-border">
                <button
                  type="button"
                  onClick={() => adjustOpponentScore(-1)}
                  className="px-3 py-1 bg-panel hover:bg-panel-border transition-colors"
                >
                  −1
                </button>
                <button
                  type="button"
                  onClick={() => adjustOpponentScore(1)}
                  className="px-3 py-1 bg-panel hover:bg-panel-border border-l border-panel-border transition-colors"
                >
                  +1
                </button>
              </div>
            </div>
          </div>
          {showStatsDrawer && (
            <div className="mt-4 rounded-lg border border-panel-border bg-surface p-3 shadow-inner shadow-black/30">
              <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider mb-2">
                Player Stats
              </h4>
              {statRows.length === 0 ? (
                <p className="text-xs text-gray-500">No players added yet.</p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-[11px] text-gray-200">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                        <th className="text-left font-semibold py-1">Player</th>
                        <th className="text-right font-semibold py-1">PTS</th>
                        {SHOT_TYPES.map((shot) => (
                          <th key={shot.key} className="text-right font-semibold py-1 px-1">
                            {shot.label} (M/A)
                          </th>
                        ))}
                        {OTHER_STATS.map((stat) => (
                          <th key={stat} className="text-right font-semibold py-1 px-1">
                            {stat}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {statRows.map(({ player, shots, others, points }) => (
                        <tr key={player.id} className="border-t border-white/5">
                          <td className="py-1 font-medium">
                            #{player.number} {player.name}
                          </td>
                          <td className="py-1 text-right font-mono">{points}</td>
                          {SHOT_TYPES.map((shot) => {
                            const data = shots[shot.key];
                            const attempts = data.makes + data.misses;
                            return (
                              <td key={`${player.id}-${shot.key}`} className="py-1 px-1 text-right font-mono text-gray-300">
                                {attempts > 0 ? `${data.makes}/${attempts}` : "-"}
                              </td>
                            );
                          })}
                          {OTHER_STATS.map((stat) => (
                            <td key={`${player.id}-${stat}`} className="py-1 px-1 text-right font-mono text-gray-400">
                              {others[stat] ?? "-"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-white/10 text-accent">
                        <td className="py-1 font-semibold">Team Total</td>
                        <td className="py-1 text-right font-mono">{teamTotals.points}</td>
                        {SHOT_TYPES.map((shot) => {
                          const data = teamTotals.shots[shot.key];
                          const attempts = data.makes + data.misses;
                          return (
                            <td key={`total-${shot.key}`} className="py-1 px-1 text-right font-mono">
                              {attempts > 0 ? `${data.makes}/${attempts}` : "-"}
                            </td>
                          );
                        })}
                        {OTHER_STATS.map((stat) => (
                          <td key={`total-${stat}`} className="py-1 px-1 text-right font-mono">
                            {teamTotals.others[stat] ?? "-"}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="p-3 border-b border-panel-border">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Stats
        </h3>
        <div className="grid grid-cols-3 gap-1.5">
          {SHOT_TYPES.map((shot) => (
            <div key={shot.key} className="flex gap-1">
              <button
                onClick={() => handleStatClick(shot.missType)}
                disabled={!videoSrc}
                className={`${shot.colorMiss} flex-1 text-white text-xs font-medium py-2 px-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                {shot.label} x
              </button>
              <button
                onClick={() => handleStatClick(shot.makeType)}
                disabled={!videoSrc}
                className={`${shot.colorMake} flex-1 text-white text-xs font-semibold py-2 px-1 rounded border border-green-400/60 shadow-[0_0_12px_rgba(74,222,128,0.35)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                {shot.label} +
              </button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1.5 pt-2 border-t border-panel-border mt-3">
            {SKILL_BUTTONS.map((btn) => (
              <button
                key={btn.type}
                onClick={() => handleStatClick(btn.type)}
                disabled={!videoSrc}
                className={`${btn.color} text-white text-xs font-medium py-2 px-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                {btn.label}
              </button>
            ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Recent Plays
        </h3>
        {recentPlays.length === 0 ? (
          <p className="text-xs text-gray-500">No plays recorded</p>
        ) : (
          <div className="space-y-1">
            {recentPlays.map((play) => (
              <div
                key={play.id}
                role="button"
                tabIndex={0}
                className="group relative flex items-center gap-2 text-xs bg-surface rounded px-2 py-1.5 cursor-pointer hover:bg-panel-border/60 focus:outline-none focus:ring-1 focus:ring-accent"
                onClick={() => jumpToPlayStart(play.start_time ?? play.timestamp)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    jumpToPlayStart(play.start_time ?? play.timestamp);
                  }
                }}
              >
                <span className="text-accent font-bold w-12">{formatEventLabel(play.event_type)}</span>
                <span className="text-gray-300 flex-1 truncate">
                  #{play.player_number} {play.player_name}
                </span>
                <span className="text-gray-500 font-mono transition-all group-hover:pr-6">
                  {play.timestamp.toFixed(1)}s
                </span>
                <button
                  className="absolute right-3 opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-red-400"
                  aria-label="Delete play"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDeletePlay(play.id);
                  }}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
          Roster ({players.length})
        </h3>
        <div className="flex flex-wrap gap-1">
          {players.map((p) => (
            <button
              key={p.id}
              onClick={() => setShowAddPlayerModal(true)}
              className="text-xs bg-surface px-2 py-0.5 rounded text-gray-300 hover:bg-panel-border transition-colors"
              title="Manage players"
            >
              #{p.number}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
