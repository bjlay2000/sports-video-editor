import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { StatType } from "../../store/types";
import { PlayCoordinator } from "../../services/PlayCoordinator";
import { DatabaseService, type PlayerPlayedPercentage } from "../../services/DatabaseService";
import { useTimelineStore } from "../../store/timelineStore";
import { videoEngine } from "../../services/VideoEngine";
import { SubstitutionModal } from "./SubstitutionModal";
import { ProjectService } from "../../services/ProjectService";

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

function csvEscape(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function ScoringPanel() {
  const game = useAppStore((s) => s.game);
  const plays = useAppStore((s) => s.plays);
  const opponentPlays = useAppStore((s) => s.opponentPlays);
  const players = useAppStore((s) => s.players);
  const setPlayers = useAppStore((s) => s.setPlayers);
  const resetOnCourtTracking = useAppStore((s) => s.resetOnCourtTracking);
  const setPendingStat = useAppStore((s) => s.setPendingStat);
  const setShowPlayerModal = useAppStore((s) => s.setShowPlayerModal);
  const setShowAddPlayerModal = useAppStore((s) => s.setShowAddPlayerModal);
  const setGame = useAppStore((s) => s.setGame);
  const onCourtIntervals = useAppStore((s) => s.onCourtIntervals);
  const playedPercentRefreshVersion = useAppStore((s) => s.playedPercentRefreshVersion);
  const opponentScoreEvents = useAppStore((s) => s.opponentScoreEvents);
  const logOpponentScoreEvent = useAppStore((s) => s.logOpponentScoreEvent);
  const logHomeScoreEvent = useAppStore((s) => s.logHomeScoreEvent);
  const videoSrc = useVideoStore((s) => s.videoSrc);
  const currentTime = useVideoStore((s) => s.currentTime);
  const duration = useVideoStore((s) => s.duration);
  const showScoreboardOverlay = useVideoStore((s) => s.showScoreboardOverlay);
  const toggleScoreboardOverlay = useVideoStore((s) => s.toggleScoreboardOverlay);
  const segments = useTimelineStore((s) => s.segments);
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime);
  const setCurrentTime = useVideoStore((s) => s.setCurrentTime);
  const isPlaying = useVideoStore((s) => s.isPlaying);
  const setIsPlaying = useVideoStore((s) => s.setIsPlaying);
  const [showStatsDrawer, setShowStatsDrawer] = useState(false);
  const [exportingStats, setExportingStats] = useState(false);
  const [showSubModal, setShowSubModal] = useState(false);
  const [playedPercentages, setPlayedPercentages] = useState<PlayerPlayedPercentage[]>([]);
  const [rosters, setRosters] = useState<Array<{ roster_id: number; name: string }>>([]);
  const [selectedRosterId, setSelectedRosterId] = useState<string>("");
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [downloadActionBusy, setDownloadActionBusy] = useState<"open" | "reveal" | null>(null);
  const gameResetVersion = useAppStore((s) => s.gameResetVersion);

  // Fetch DB-derived played % from backend only
  useEffect(() => {
    let cancelled = false;
    DatabaseService.getPlayedPercentages()
      .then((rows) => {
        if (!cancelled) {
          setPlayedPercentages(rows);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPlayedPercentages([]);
        }
        console.error("Failed to load played percentages", error);
      });
    return () => { cancelled = true; };
  }, [players, onCourtIntervals, segments, plays, playedPercentRefreshVersion]);

  useEffect(() => {
    let cancelled = false;
    DatabaseService.getRosters()
      .then((items) => {
        if (!cancelled) {
          setRosters(items.map((r) => ({ roster_id: r.roster_id, name: r.name })));
        }
      })
      .catch((error) => {
        console.error("Failed to load rosters", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset roster selection when a new game starts
  useEffect(() => {
    if (gameResetVersion > 0) {
      setSelectedRosterId("");
    }
  }, [gameResetVersion]);

  const handleRosterSelection = async (nextValue: string) => {
    if (!nextValue) {
      setSelectedRosterId("");
      localStorage.removeItem("sve.selectedRosterId");
      return;
    }

    if (plays.length > 0) {
      window.alert("Clear stat tags before replacing roster, then try again.");
      return;
    }

    setSelectedRosterId(nextValue);
    localStorage.setItem("sve.selectedRosterId", nextValue);

    try {
      await ProjectService.ensureProjectDbOpen();
      const rosterPlayers = await DatabaseService.getRosterPlayers(Number(nextValue));
      const projectPlayers = rosterPlayers.map((player, index) => ({
        id: index + 1,
        name: player.name,
        number: player.number,
      }));
      await DatabaseService.savePlayersBulk(projectPlayers);
      const freshPlayers = await DatabaseService.getPlayers();
      setPlayers(freshPlayers);
      resetOnCourtTracking();
    } catch (error) {
      console.error("Failed to apply roster", error);
    }
  };

  const handleDeleteSelectedRoster = async () => {
    if (!selectedRosterId) return;
    const rosterId = Number(selectedRosterId);
    if (!Number.isFinite(rosterId) || rosterId <= 0) return;

    const target = rosters.find((r) => r.roster_id === rosterId);
    const ok = await confirm(`Delete saved roster \"${target?.name ?? "this roster"}\"?`, {
      title: "Delete Roster",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!ok) return;

    try {
      await DatabaseService.deleteRoster(rosterId);
      const refreshed = await DatabaseService.getRosters();
      setRosters(refreshed.map((r) => ({ roster_id: r.roster_id, name: r.name })));
      setSelectedRosterId("");
      localStorage.removeItem("sve.selectedRosterId");
      // Clear players from both in-memory state AND the project database
      await DatabaseService.savePlayersBulk([]);
      setPlayers([]);
      resetOnCourtTracking();
    } catch (error) {
      console.error("Failed to delete roster", error);
    }
  };

  const handleSaveAsRoster = async () => {
    if (players.length === 0) {
      window.alert("Add players before saving a roster.");
      return;
    }
    const defaultName = `Roster ${new Date().toLocaleDateString()}`;
    const name = window.prompt("Roster name", defaultName)?.trim();
    if (!name) return;

    try {
      const roster = await DatabaseService.createRoster(name);
      await DatabaseService.saveRosterPlayers(
        roster.roster_id,
        players.map((player) => ({ name: player.name, number: player.number })),
      );
      const refreshed = await DatabaseService.getRosters();
      setRosters(refreshed.map((r) => ({ roster_id: r.roster_id, name: r.name })));
      setSelectedRosterId(String(roster.roster_id));
      localStorage.setItem("sve.selectedRosterId", String(roster.roster_id));
    } catch (error) {
      console.error("Failed to save roster", error);
    }
  };

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

  const adjustHomeScore = async (delta: number) => {
    const nextHome = Math.max(0, game.home_score + delta);
    if (nextHome === game.home_score) return;
    const updated = await DatabaseService.updateScore(nextHome, game.away_score);
    setGame(updated);
    logHomeScoreEvent(nextHome, currentTime);
  };

  const handleScoreboardPlayPause = useCallback(async () => {
    if (!videoSrc) return;
    try {
      if (isPlaying) {
        videoEngine.pause();
        setIsPlaying(false);
      } else {
        await videoEngine.play();
        setIsPlaying(true);
      }
    } catch (error) {
      console.error("Failed to toggle playback from scoreboard", error);
    }
  }, [isPlaying, setIsPlaying, videoSrc]);

  const { statRows, teamTotals, totalProjectDuration } = useMemo(() => {
    const durationFromBackend = playedPercentages[0]?.total_duration ?? 0;
    const playedMap = new Map(playedPercentages.map((row) => [row.player_id, row]));

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
      const played = playedMap.get(player.id);
      const playedSec = played?.played_seconds ?? 0;
      const percentPlayed = played?.percent_played ?? 0;
      return { player, shots, others, points, playedSec, percentPlayed };
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
      { shots: createEmptyShotTotals(), others: createEmptyOtherTotals(), points: 0, playedSec: 0 }
    );

    const teamPlayedPercent = durationFromBackend > 0
      ? (totals.playedSec / (durationFromBackend * Math.max(1, players.length))) * 100
      : 0;

    return {
      statRows: rows,
      teamTotals: { ...totals, teamPlayedPercent },
      totalProjectDuration: durationFromBackend,
    };
  }, [players, plays, playedPercentages]);

  const opponentTotals = useMemo(() => {
    const shots = createEmptyShotTotals();
    const others = createEmptyOtherTotals();
    opponentPlays.forEach((play) => {
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
        others[statKey as OtherStat] += 1;
      }
    });
    const points = SHOT_TYPES.reduce(
      (sum, shot) => sum + shots[shot.key].makes * shot.points,
      0
    );
    return { shots, others, points };
  }, [opponentPlays]);

  const hasStatsOrBoxScore = statRows.length > 0 || opponentPlays.length > 0;
  const exportedFileName = useMemo(() => {
    if (!lastExportPath) return "";
    const parts = lastExportPath.split(/[\\/]/);
    return parts[parts.length - 1] || lastExportPath;
  }, [lastExportPath]);

  const handleExportStatsCsv = useCallback(async () => {
    if (!hasStatsOrBoxScore) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = await save({
      defaultPath: `game_stats_${timestamp}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!outputPath) return;

    const normalizedPath = outputPath.toLowerCase().endsWith(".csv") ? outputPath : `${outputPath}.csv`;

    const columns = [
      "Player",
      "PTS",
      "% Played",
      ...SHOT_TYPES.map((shot) => `${shot.label} (M/A)`),
      ...OTHER_STATS,
    ];

    const lines: string[] = [];
    lines.push("Player Stats");
    lines.push(columns.map(csvEscape).join(","));

    if (statRows.length > 0) {
      for (const row of statRows) {
        lines.push([
          csvEscape(`#${row.player.number} ${row.player.name}`),
          csvEscape(row.points),
          csvEscape(`${row.percentPlayed.toFixed(1)}%`),
          ...SHOT_TYPES.map((shot) => {
            const d = row.shots[shot.key];
            const attempts = d.makes + d.misses;
            return csvEscape(attempts > 0 ? `${d.makes}/${attempts}` : "-");
          }),
          ...OTHER_STATS.map((stat) => csvEscape(row.others[stat] ?? "-")),
        ].join(","));
      }
    }

    lines.push([
      csvEscape("Team Total"),
      csvEscape(teamTotals.points),
      csvEscape(`${teamTotals.teamPlayedPercent.toFixed(1)}%`),
      ...SHOT_TYPES.map((shot) => {
        const d = teamTotals.shots[shot.key];
        const attempts = d.makes + d.misses;
        return csvEscape(attempts > 0 ? `${d.makes}/${attempts}` : "-");
      }),
      ...OTHER_STATS.map((stat) => csvEscape(teamTotals.others[stat] ?? "-")),
    ].join(","));

    lines.push("");
    lines.push("Box Score");
    lines.push([
      csvEscape("Team"),
      csvEscape("PTS"),
      ...SHOT_TYPES.map((shot) => csvEscape(`${shot.label} (M/A)`)),
      ...OTHER_STATS.map((stat) => csvEscape(stat)),
    ].join(","));

    lines.push([
      csvEscape("Home"),
      csvEscape(teamTotals.points),
      ...SHOT_TYPES.map((shot) => {
        const d = teamTotals.shots[shot.key];
        const attempts = d.makes + d.misses;
        return csvEscape(attempts > 0 ? `${d.makes}/${attempts}` : "-");
      }),
      ...OTHER_STATS.map((stat) => csvEscape(teamTotals.others[stat] ?? "-")),
    ].join(","));

    lines.push([
      csvEscape("Opponent"),
      csvEscape(opponentTotals.points),
      ...SHOT_TYPES.map((shot) => {
        const d = opponentTotals.shots[shot.key];
        const attempts = d.makes + d.misses;
        return csvEscape(attempts > 0 ? `${d.makes}/${attempts}` : "-");
      }),
      ...OTHER_STATS.map((stat) => csvEscape(opponentTotals.others[stat] ?? "-")),
    ].join(","));

    try {
      setExportingStats(true);
      await writeFile(normalizedPath, new TextEncoder().encode(lines.join("\n")));
      setLastExportPath(normalizedPath);
    } finally {
      setExportingStats(false);
    }
  }, [hasStatsOrBoxScore, statRows, teamTotals, opponentTotals]);

  const handleOpenExportedFile = useCallback(async () => {
    if (!lastExportPath) return;
    try {
      setDownloadActionBusy("open");
      await invoke("open_file_path", { path: lastExportPath });
    } catch (error) {
      console.error("Failed to open exported file", error);
    } finally {
      setDownloadActionBusy(null);
    }
  }, [lastExportPath]);

  const handleRevealExportedFile = useCallback(async () => {
    if (!lastExportPath) return;
    try {
      setDownloadActionBusy("reveal");
      await invoke("reveal_file_in_folder", { path: lastExportPath });
    } catch (error) {
      console.error("Failed to reveal exported file", error);
    } finally {
      setDownloadActionBusy(null);
    }
  }, [lastExportPath]);

  const handlePrintStats = useCallback(() => {
    if (!hasStatsOrBoxScore) return;

    const columns = [
      "Player",
      "PTS",
      "% Played",
      ...SHOT_TYPES.map((shot) => `${shot.label} (M/A)`),
      ...OTHER_STATS,
    ];

    const rowsHtml = statRows
      .map((row) => {
        const shotCells = SHOT_TYPES.map((shot) => {
          const d = row.shots[shot.key];
          const attempts = d.makes + d.misses;
          return `<td>${attempts > 0 ? `${d.makes}/${attempts}` : "-"}</td>`;
        }).join("");

        const otherCells = OTHER_STATS.map((stat) => `<td>${row.others[stat] ?? "-"}</td>`).join("");

        return `<tr><td>#${row.player.number} ${row.player.name}</td><td>${row.points}</td><td>${row.percentPlayed.toFixed(1)}%</td>${shotCells}${otherCells}</tr>`;
      })
      .join("");

    const totalShotCells = SHOT_TYPES.map((shot) => {
      const d = teamTotals.shots[shot.key];
      const attempts = d.makes + d.misses;
      return `<td>${attempts > 0 ? `${d.makes}/${attempts}` : "-"}</td>`;
    }).join("");

    const totalOtherCells = OTHER_STATS.map((stat) => `<td>${teamTotals.others[stat] ?? "-"}</td>`).join("");

    const boxColumns = [
      "Team",
      "PTS",
      ...SHOT_TYPES.map((shot) => `${shot.label} (M/A)`),
      ...OTHER_STATS,
    ];

    const homeBoxCells = [
      `<td>Home</td>`,
      `<td>${teamTotals.points}</td>`,
      ...SHOT_TYPES.map((shot) => {
        const d = teamTotals.shots[shot.key];
        const attempts = d.makes + d.misses;
        return `<td>${attempts > 0 ? `${d.makes}/${attempts}` : "-"}</td>`;
      }),
      ...OTHER_STATS.map((stat) => `<td>${teamTotals.others[stat] ?? "-"}</td>`),
    ].join("");

    const opponentBoxCells = [
      `<td>Opponent</td>`,
      `<td>${opponentTotals.points}</td>`,
      ...SHOT_TYPES.map((shot) => {
        const d = opponentTotals.shots[shot.key];
        const attempts = d.makes + d.misses;
        return `<td>${attempts > 0 ? `${d.makes}/${attempts}` : "-"}</td>`;
      }),
      ...OTHER_STATS.map((stat) => `<td>${opponentTotals.others[stat] ?? "-"}</td>`),
    ].join("");

    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const printDoc = iframe.contentDocument;
    const printWindow = iframe.contentWindow;
    if (!printDoc || !printWindow) {
      document.body.removeChild(iframe);
      return;
    }

    printDoc.open();
    printDoc.write(`
      <html>
        <head>
          <title>Game Stats</title>
          <style>
            body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
            h1 { margin: 0 0 12px; font-size: 20px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: right; }
            th:first-child, td:first-child { text-align: left; }
            thead th { background: #f3f4f6; }
            tfoot td { font-weight: 700; background: #f9fafb; }
          </style>
        </head>
        <body>
          <h1>Game Stats</h1>
          <table>
            <thead>
              <tr>${columns.map((col) => `<th>${col}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
            <tfoot>
              <tr>
                <td>Team Total</td>
                <td>${teamTotals.points}</td>
                <td>${teamTotals.teamPlayedPercent.toFixed(1)}%</td>
                ${totalShotCells}
                ${totalOtherCells}
              </tr>
            </tfoot>
          </table>
          <h1 style="margin-top: 20px;">Box Score</h1>
          <table>
            <thead>
              <tr>${boxColumns.map((col) => `<th>${col}</th>`).join("")}</tr>
            </thead>
            <tbody>
              <tr>${homeBoxCells}</tr>
              <tr>${opponentBoxCells}</tr>
            </tbody>
          </table>
        </body>
      </html>
    `);
    printDoc.close();

    const cleanup = () => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    };

    printWindow.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 50);
    setTimeout(cleanup, 1500);
  }, [hasStatsOrBoxScore, statRows, teamTotals, opponentTotals]);

  return (
    <div id="scoring-panel" className="relative h-full flex flex-col bg-panel overflow-hidden">
      <div className="flex-1 p-3 border-b border-panel-border flex flex-col min-h-0">
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
          <button
            onClick={() => {
              setShowStatsDrawer((prev) => !prev);
            }}
            className="text-xs px-2 py-1 bg-panel hover:bg-panel-border rounded transition-colors text-gray-200"
          >
            {showStatsDrawer ? "Hide Stats" : "Game Stats"}
          </button>
        </div>

        {/* Score display — centered vertically in the available space */}
        <div className="flex-1 flex items-center justify-center min-h-0">
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
        </div>

        {/* Stats drawer — animated overlay sliding in from the right */}
        <div
          className={`absolute inset-0 z-10 bg-panel flex flex-col transition-transform duration-300 ease-in-out ${
            showStatsDrawer ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between p-3 border-b border-panel-border flex-shrink-0">
            <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
              Game Stats
            </h4>
            <div className="flex flex-col items-end gap-1.5">
              {lastExportPath && (
                <div className="flex max-w-[360px] items-center gap-2 rounded border border-panel-border bg-[#0f1118] px-2 py-1 text-[11px]">
                  <button
                    type="button"
                    onClick={handleOpenExportedFile}
                    disabled={downloadActionBusy !== null}
                    className="truncate text-accent hover:underline disabled:opacity-50 disabled:no-underline"
                    title={lastExportPath}
                  >
                    {exportedFileName}
                  </button>
                  <button
                    type="button"
                    onClick={handleRevealExportedFile}
                    disabled={downloadActionBusy !== null}
                    className="whitespace-nowrap text-gray-300 hover:text-white disabled:opacity-50"
                  >
                    Show Folder
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title="Export Stats CSV"
                  onClick={handleExportStatsCsv}
                  disabled={exportingStats || !hasStatsOrBoxScore}
                  className="rounded p-2 text-gray-300 hover:bg-panel-border disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v11" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M4 20h16" />
                  </svg>
                </button>
                <button
                  type="button"
                  title="Print Stats"
                  onClick={handlePrintStats}
                  disabled={!hasStatsOrBoxScore}
                  className="rounded p-2 text-gray-300 hover:bg-panel-border disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="6" y="3" width="12" height="6" rx="1" />
                    <rect x="6" y="14" width="12" height="7" rx="1" />
                    <path d="M4 10h16a1 1 0 0 1 1 1v4h-3" />
                    <path d="M3 15v-4a1 1 0 0 1 1-1" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setShowStatsDrawer(false)}
                  className="rounded px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-panel-border transition-colors"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-3">
            {statRows.length === 0 ? (
              <p className="text-xs text-gray-500">No players added yet.</p>
            ) : (
              <table className="w-full text-[11px] text-gray-200">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                    <th className="text-left font-semibold py-1">Player</th>
                    <th className="text-right font-semibold py-1">PTS</th>
                    <th className="text-right font-semibold py-1">% Played</th>
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
                  {statRows.map(({ player, shots, others, points, percentPlayed }) => (
                    <tr key={player.id} className="border-t border-white/5">
                      <td className="py-1 font-medium">
                        #{player.number} {player.name}
                      </td>
                      <td className="py-1 text-right font-mono">{points}</td>
                      <td className="py-1 text-right font-mono">{percentPlayed.toFixed(1)}%</td>
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
                    <td className="py-1 text-right font-mono">{teamTotals.teamPlayedPercent.toFixed(1)}%</td>
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
            )}

            {/* Box Score — Home vs Opponent comparison */}
            {(statRows.length > 0 || opponentPlays.length > 0) && (
              <div className="mt-4 pt-3 border-t border-panel-border">
                <h5 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Box Score
                </h5>
                <table className="w-full text-[11px] text-gray-200">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                      <th className="text-left font-semibold py-1">Team</th>
                      <th className="text-right font-semibold py-1">PTS</th>
                      {SHOT_TYPES.map((shot) => (
                        <th key={shot.key} className="text-right font-semibold py-1 px-1">
                          {shot.label}
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
                    <tr className="border-t border-white/5">
                      <td className="py-1 font-medium text-accent">Home</td>
                      <td className="py-1 text-right font-mono font-bold">{teamTotals.points}</td>
                      {SHOT_TYPES.map((shot) => {
                        const d = teamTotals.shots[shot.key];
                        const a = d.makes + d.misses;
                        return (
                          <td key={`box-home-${shot.key}`} className="py-1 px-1 text-right font-mono text-gray-300">
                            {a > 0 ? `${d.makes}/${a}` : "-"}
                          </td>
                        );
                      })}
                      {OTHER_STATS.map((stat) => (
                        <td key={`box-home-${stat}`} className="py-1 px-1 text-right font-mono text-gray-400">
                          {teamTotals.others[stat] || "-"}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-t border-white/5">
                      <td className="py-1 font-medium text-red-400">Opponent</td>
                      <td className="py-1 text-right font-mono font-bold">{opponentTotals.points}</td>
                      {SHOT_TYPES.map((shot) => {
                        const d = opponentTotals.shots[shot.key];
                        const a = d.makes + d.misses;
                        return (
                          <td key={`box-opp-${shot.key}`} className="py-1 px-1 text-right font-mono text-gray-300">
                            {a > 0 ? `${d.makes}/${a}` : "-"}
                          </td>
                        );
                      })}
                      {OTHER_STATS.map((stat) => (
                        <td key={`box-opp-${stat}`} className="py-1 px-1 text-right font-mono text-gray-400">
                          {opponentTotals.others[stat] || "-"}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Controls — always docked at the bottom of the scoreboard section */}
        <div className="pt-3 flex flex-col gap-2">
          <div className="flex justify-center items-center gap-3">
            <button
              type="button"
              onClick={() => {
                if (!videoSrc) return;
                const newTime = Math.max(0, currentTime - 5);
                videoEngine.seek(newTime);
                setCurrentTime(newTime);
                setPlayheadTime(newTime);
              }}
              disabled={!videoSrc}
              className="text-gray-500 hover:text-accent text-lg leading-none transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title="Back 5 sec"
            >
              <span className="inline-block -rotate-90">↺</span>
            </button>
            <button
              type="button"
              onClick={handleScoreboardPlayPause}
              disabled={!videoSrc}
              className="text-white hover:text-accent text-3xl leading-none transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Play/Pause"
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!videoSrc) return;
                const newTime = Math.min(duration, currentTime + 5);
                videoEngine.seek(newTime);
                setCurrentTime(newTime);
                setPlayheadTime(newTime);
              }}
              disabled={!videoSrc}
              className="text-gray-500 hover:text-accent text-lg leading-none transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title="Forward 5 sec"
            >
              <span className="inline-block rotate-90">↻</span>
            </button>
          </div>
          <div className="grid grid-cols-3 items-end gap-2">
            <div className="flex flex-col items-start gap-1 text-[11px] text-gray-400 uppercase tracking-wider">
              <span>Home Score</span>
              <div className="flex overflow-hidden rounded border border-panel-border">
                <button
                  type="button"
                  onClick={() => adjustHomeScore(-1)}
                  className="px-3 py-1 bg-panel hover:bg-panel-border transition-colors"
                >
                  −1
                </button>
                <button
                  type="button"
                  onClick={() => adjustHomeScore(1)}
                  className="px-3 py-1 bg-panel hover:bg-panel-border border-l border-panel-border transition-colors"
                >
                  +1
                </button>
              </div>
            </div>
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setShowSubModal(true)}
                disabled={players.length === 0}
                className="text-[10px] px-2 py-0.5 rounded border transition-all duration-150 disabled:opacity-30 disabled:cursor-not-allowed bg-panel border-accent text-gray-300 hover:text-accent hover:border-white hover:shadow-[0_0_8px_rgba(255,255,255,0.3)]"
                title="Substitutions"
              >
                Sub
              </button>
            </div>
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
        <div className="grid grid-cols-3 gap-1.5 pt-2 mt-2">
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

      <div className="p-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
          Roster ({players.length})
        </h3>
        <div className="flex items-center gap-2 mb-2">
          <select
            value={selectedRosterId}
            onChange={(event) => {
              void handleRosterSelection(event.target.value);
            }}
            className="flex-1 px-2 py-1 bg-surface border border-panel-border rounded text-xs text-gray-200"
          >
            <option value="">Select a saved roster</option>
            {rosters.map((roster) => (
              <option key={roster.roster_id} value={roster.roster_id}>
                {roster.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              void handleDeleteSelectedRoster();
            }}
            disabled={!selectedRosterId}
            className="px-2 py-1 bg-panel hover:bg-panel-border rounded text-xs text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Delete selected saved roster"
          >
            Delete
          </button>
          <button
            onClick={() => {
              void handleSaveAsRoster();
            }}
            className="px-2 py-1 bg-panel hover:bg-panel-border rounded text-xs text-gray-200 transition-colors"
          >
            Save As Roster
          </button>
        </div>
        <div className="mb-2 flex items-start gap-2">
          <div className="flex flex-wrap gap-1 flex-1">
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
          <button
            onClick={() => setShowAddPlayerModal(true)}
            className="text-xs px-2 py-1 bg-accent hover:bg-accent-hover rounded transition-colors shrink-0"
          >
            + Player
          </button>
        </div>
      </div>

      {showSubModal && (
        <SubstitutionModal onClose={() => setShowSubModal(false)} />
      )}
    </div>
  );
}
