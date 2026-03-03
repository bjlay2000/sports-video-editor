import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { useVideoStore } from "../../store/videoStore";
import { DatabaseService } from "../../services/DatabaseService";
import { ProjectService } from "../../services/ProjectService";
import { useToastStore } from "../../store/toastStore";
import type { StatType } from "../../store/types";

const SCORING_STATS = ["2PT", "3PT", "FT"];
const ASSIST_PROMPT_STATS: StatType[] = ["2PT", "3PT"];
const REBOUND_PROMPT_STATS: StatType[] = ["2PT_MISS", "3PT_MISS", "FT_MISS", "BLK"];

type SelectionStep =
  | "primary"
  | "assist"
  | "rebound"
  | "opponentAssistChoice"
  | "blockShotType"
  | "blockMissShooter";
type PossessionSide = "home" | "opponent";
type BlockShotType = "2PT" | "3PT";

interface FollowUpContext {
  captureTime: number;
  startTime: number;
  endTime: number;
  needsRebound: boolean;
  side: PossessionSide;
  primaryPlayerId: number | null;
  blockMissType?: StatType;
}

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
  const onCourtPlayerIds = useAppStore((s) => s.onCourtPlayerIds);
  const setOnCourtStatusAtTime = useAppStore((s) => s.setOnCourtStatusAtTime);
  const ensurePlayerOnCourtAtTime = useAppStore((s) => s.ensurePlayerOnCourtAtTime);
  const bumpPlayedPercentRefresh = useAppStore((s) => s.bumpPlayedPercentRefresh);
  const addPlay = useAppStore((s) => s.addPlay);
  const addMarker = useAppStore((s) => s.addMarker);
  const game = useAppStore((s) => s.game);
  const setGame = useAppStore((s) => s.setGame);
  const addOpponentPlay = useAppStore((s) => s.addOpponentPlay);
  const logOpponentScoreEvent = useAppStore((s) => s.logOpponentScoreEvent);
  const currentTime = useVideoStore((s) => s.currentTime);
  const logHomeScoreEvent = useAppStore((s) => s.logHomeScoreEvent);
  const pushToast = useToastStore((s) => s.pushToast);
  const [step, setStep] = useState<SelectionStep>("primary");
  const [followUpContext, setFollowUpContext] = useState<FollowUpContext | null>(null);
  const [modalLeft, setModalLeft] = useState<number | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const getScoreDelta = (stat: string) =>
    stat === "3PT" ? 3 : stat === "2PT" ? 2 : stat === "FT" ? 1 : 0;

  const addOpponentStat = async (eventType: string, captureTime: number) => {
    await ProjectService.ensureProjectDbOpen();
    const result = await DatabaseService.addOpponentStat(captureTime, eventType);
    addOpponentPlay({ id: result.id, timestamp: result.timestamp, event_type: result.event_type });
  };

  useLayoutEffect(() => {
    const updatePosition = () => {
      const panel = document.getElementById("scoring-panel");
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      setModalLeft(rect.left + rect.width / 2);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    const panel = document.getElementById("scoring-panel");
    if (panel) observer.observe(panel);
    window.addEventListener("resize", updatePosition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, []);

  const persistShiftsFromStore = async () => {
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

  const handleToggleOnCourt = async (playerId: number, onCourt: boolean, toggleTime: number) => {
    setOnCourtStatusAtTime(playerId, onCourt, toggleTime);
    try {
      await persistShiftsFromStore();
    } catch (error) {
      console.error("Failed to save on-court toggle", error);
      pushToast("Failed to save lineup change", "error");
    }
  };

  useEffect(() => {
    setStep("primary");
    setFollowUpContext(null);
  }, [pendingStat, pendingStatTimestamp]);

  const captureDefaults = useMemo(() => {
    const captureTime = pendingStatTimestamp ?? currentTime;
    return {
      captureTime,
      startTime: Math.max(0, captureTime - 5),
      endTime: captureTime + 2,
    };
  }, [pendingStatTimestamp, currentTime]);

  const sortedPlayers = useMemo(
    () => [...players].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name)),
    [players],
  );

  const selectablePlayers = useMemo(() => {
    if (step !== "assist" || !followUpContext || followUpContext.primaryPlayerId == null) {
      return sortedPlayers;
    }
    return sortedPlayers.filter((player) => player.id !== followUpContext.primaryPlayerId);
  }, [step, followUpContext, sortedPlayers]);

  const onCourtSet = useMemo(() => new Set(onCourtPlayerIds), [onCourtPlayerIds]);
  const playersOnCourt = useMemo(
    () => selectablePlayers.filter((player) => onCourtSet.has(player.id)),
    [selectablePlayers, onCourtSet],
  );
  const playersOffCourt = useMemo(
    () => selectablePlayers.filter((player) => !onCourtSet.has(player.id)),
    [selectablePlayers, onCourtSet],
  );

  const persistPlay = async (
    playerId: number,
    eventType: StatType,
    captureTime: number,
    startTime: number,
    endTime: number,
    scoreDelta: number | null = null,
  ) => {
    await ProjectService.ensureProjectDbOpen();
    // Transactional: play + score + shift in single backend transaction
    const result = await DatabaseService.recordStatWithSideEffects({
      timestamp: captureTime,
      playerId,
      eventType,
      startTime,
      endTime,
      scoreDelta,
      ensureOnCourt: true,
      courtEnterTime: captureTime,
    });

    // Update frontend stores from the transactional result
    ensurePlayerOnCourtAtTime(playerId, captureTime);
    addPlay(result.play);
    addMarker({
      id: result.play.id,
      time: result.play.timestamp,
      event_type: result.play.event_type,
      player_name: result.play.player_name,
      start_time: result.play.start_time,
      end_time: result.play.end_time,
      label: result.play.event_type,
    });
    setGame(result.game);
    if (scoreDelta != null && scoreDelta > 0) {
      logHomeScoreEvent(result.game.home_score, captureTime);
    }
    bumpPlayedPercentRefresh();

    return result.play;
  };

  const closeModal = () => {
    setPendingStat(null);
    setShowPlayerModal(false);
    setStep("primary");
    setFollowUpContext(null);
  };

  const handlePrimarySelect = async (playerId: number) => {
    if (!pendingStat) return;

    const { captureTime, startTime, endTime } = captureDefaults;

    try {
      const scoreDelta = SCORING_STATS.includes(pendingStat)
        ? getScoreDelta(pendingStat)
        : null;

      await persistPlay(playerId, pendingStat as StatType, captureTime, startTime, endTime, scoreDelta);

      const needsAssist = ASSIST_PROMPT_STATS.includes(pendingStat as StatType);
      const needsRebound = REBOUND_PROMPT_STATS.includes(pendingStat as StatType);

      if (pendingStat === "BLK") {
        setFollowUpContext({
          captureTime,
          startTime,
          endTime,
          needsRebound,
          side: "home",
          primaryPlayerId: playerId,
        });
        setStep("blockShotType");
        return;
      }

      if (needsAssist || needsRebound) {
        setFollowUpContext({
          captureTime,
          startTime,
          endTime,
          needsRebound,
          side: "home",
          primaryPlayerId: playerId,
        });
        setStep(needsAssist ? "assist" : "rebound");
        return;
      }
    } catch (e) {
      console.error("Failed to add play:", e);
    }

    closeModal();
  };

  const handleOpponentSelect = async () => {
    if (!pendingStat) return;

    const { captureTime, startTime, endTime } = captureDefaults;

    try {
      await addOpponentStat(pendingStat, captureTime);

      // For scoring stats, adjust away score
      const scoreDelta = SCORING_STATS.includes(pendingStat)
        ? getScoreDelta(pendingStat)
        : 0;
      if (scoreDelta > 0) {
        const nextAway = game.away_score + scoreDelta;
        const updated = await DatabaseService.updateScore(game.home_score, nextAway);
        setGame(updated);
        logOpponentScoreEvent(nextAway, captureTime);
      }

      const needsAssist = ASSIST_PROMPT_STATS.includes(pendingStat as StatType);
      const needsRebound = REBOUND_PROMPT_STATS.includes(pendingStat as StatType);

      if (pendingStat === "BLK") {
        setFollowUpContext({
          captureTime,
          startTime,
          endTime,
          needsRebound,
          side: "opponent",
          primaryPlayerId: null,
        });
        setStep("blockShotType");
        return;
      }

      if (needsAssist || needsRebound) {
        setFollowUpContext({
          captureTime,
          startTime,
          endTime,
          needsRebound,
          side: "opponent",
          primaryPlayerId: null,
        });
        setStep(needsAssist ? "opponentAssistChoice" : "rebound");
        return;
      }
    } catch (e) {
      console.error("Failed to add opponent stat:", e);
      pushToast("Failed to record opponent stat", "error");
    }

    closeModal();
  };

  const handleAssistSelect = async (playerId: number) => {
    if (!followUpContext) return;
    try {
      await persistPlay(
        playerId,
        "AST",
        followUpContext.captureTime,
        followUpContext.startTime,
        followUpContext.endTime,
      );
    } catch (e) {
      console.error("Failed to add assist:", e);
    }

    if (followUpContext.needsRebound) {
      setStep("rebound");
      return;
    }
    closeModal();
  };

  const handleNoAssist = () => {
    if (followUpContext?.needsRebound) {
      setStep("rebound");
      return;
    }
    closeModal();
  };

  const handleOpponentAssistChoice = async (withAssist: boolean) => {
    if (!followUpContext) {
      closeModal();
      return;
    }
    try {
      if (withAssist) {
        await addOpponentStat("AST", followUpContext.captureTime);
      }
    } catch (e) {
      console.error("Failed to add opponent assist:", e);
      pushToast("Failed to record opponent assist", "error");
      closeModal();
      return;
    }

    if (followUpContext.needsRebound) {
      setStep("rebound");
      return;
    }
    closeModal();
  };

  const handleBlockShotTypeSelect = async (shotType: BlockShotType) => {
    if (!followUpContext) {
      closeModal();
      return;
    }
    try {
      const missType: StatType = shotType === "3PT" ? "3PT_MISS" : "2PT_MISS";
      if (followUpContext.side === "home") {
        await addOpponentStat(missType, followUpContext.captureTime);
      } else {
        setFollowUpContext({ ...followUpContext, blockMissType: missType });
        setStep("blockMissShooter");
        return;
      }
    } catch (e) {
      console.error("Failed to record blocked shot miss:", e);
      pushToast("Failed to record blocked shot", "error");
      closeModal();
      return;
    }

    if (followUpContext.needsRebound) {
      setStep("rebound");
      return;
    }
    closeModal();
  };

  const handleBlockMissShooterSelect = async (playerId: number) => {
    if (!followUpContext?.blockMissType) {
      closeModal();
      return;
    }
    try {
      await persistPlay(
        playerId,
        followUpContext.blockMissType,
        followUpContext.captureTime,
        followUpContext.startTime,
        followUpContext.endTime,
      );
    } catch (e) {
      console.error("Failed to add blocked shot miss:", e);
      pushToast("Failed to record blocked shot miss", "error");
      closeModal();
      return;
    }

    if (followUpContext.needsRebound) {
      setStep("rebound");
      return;
    }
    closeModal();
  };

  const handleReboundSelect = async (playerId: number) => {
    if (!followUpContext) return;
    try {
      await persistPlay(
        playerId,
        "REB",
        followUpContext.captureTime,
        followUpContext.startTime,
        followUpContext.endTime,
      );
    } catch (e) {
      console.error("Failed to add rebound:", e);
    }
    closeModal();
  };

  const handleOpponentRebound = async () => {
    if (!followUpContext) {
      closeModal();
      return;
    }
    try {
      await addOpponentStat("REB", followUpContext.captureTime);
    } catch (e) {
      console.error("Failed to add opponent rebound:", e);
      pushToast("Failed to record opponent rebound", "error");
    }
    closeModal();
  };

  const handleClose = () => {
    closeModal();
  };

  const modalTitle =
    step === "primary"
      ? <><span className="text-gray-400">Select Player — </span><span className="text-accent">{describeStat(pendingStat)}</span></>
      : step === "assist"
        ? <>Select <span className="text-blue-400 font-bold">Assist</span> Player</>
        : step === "opponentAssistChoice"
          ? <>Opponent <span className="text-blue-400 font-bold">Assist</span>?</>
          : step === "blockShotType"
            ? <>Blocked Shot Type</>
            : step === "blockMissShooter"
              ? <>Select <span className="text-gray-300 font-bold">Missed Shot</span> Player</>
            : <>Select <span className="text-yellow-400 font-bold">Rebound</span> Player</>;

  const onSelect =
    step === "primary"
      ? handlePrimarySelect
      : step === "assist"
        ? handleAssistSelect
      : step === "blockMissShooter"
        ? handleBlockMissShooterSelect
        : handleReboundSelect;

  return (
    <div className="fixed inset-0 bg-black/60 z-50">
      <div
        ref={modalRef}
        className="bg-panel border border-panel-border rounded-lg p-5 w-80 max-h-[calc(100vh-4rem)] overflow-y-auto absolute"
        style={{
          left: modalLeft !== null ? `${modalLeft}px` : "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-white">{modalTitle}</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ✕
          </button>
        </div>

        {step === "assist" && (
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={handleNoAssist}
              className="px-2 py-1 text-[11px] bg-panel border border-panel-border rounded hover:bg-panel-border transition-colors"
            >
              No Assist
            </button>
          </div>
        )}

        {step === "opponentAssistChoice" && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                void handleOpponentAssistChoice(false);
              }}
              className="px-2 py-1 text-[11px] bg-panel border border-panel-border rounded hover:bg-panel-border transition-colors"
            >
              No Assist
            </button>
            <button
              type="button"
              onClick={() => {
                void handleOpponentAssistChoice(true);
              }}
              className="px-2 py-1 text-[11px] bg-panel border border-panel-border rounded hover:bg-panel-border transition-colors"
            >
              Assist
            </button>
          </div>
        )}

        {step === "blockShotType" && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                void handleBlockShotTypeSelect("2PT");
              }}
              className="px-2 py-1 text-[11px] bg-panel border border-panel-border rounded hover:bg-panel-border transition-colors"
            >
              2PT Shot
            </button>
            <button
              type="button"
              onClick={() => {
                void handleBlockShotTypeSelect("3PT");
              }}
              className="px-2 py-1 text-[11px] bg-panel border border-panel-border rounded hover:bg-panel-border transition-colors"
            >
              3PT Shot
            </button>
          </div>
        )}

        {step === "rebound" && (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => {
                void handleOpponentRebound();
              }}
              className="w-full text-left px-3 py-2 bg-red-900/40 hover:bg-red-800/50 border border-red-700/40 rounded transition-colors flex items-center gap-3"
            >
              <span className="text-red-400 font-bold text-sm">OPP</span>
              <span className="text-red-300 text-sm flex-1">Opponent</span>
            </button>
          </div>
        )}

        {step !== "opponentAssistChoice" && step !== "blockShotType" && (
        <div className="space-y-2">
          {step === "primary" && (
            <button
              type="button"
              onClick={handleOpponentSelect}
              className="w-full text-left px-3 py-2 bg-red-900/40 hover:bg-red-800/50 border border-red-700/40 rounded transition-colors flex items-center gap-3"
            >
              <span className="text-red-400 font-bold text-sm">OPP</span>
              <span className="text-red-300 text-sm flex-1">Opponent</span>
            </button>
          )}
          <div className="text-[10px] uppercase tracking-wider text-gray-500">On Court</div>
          <div className="space-y-1.5">
            {playersOnCourt.map((player) => (
              <button
                key={player.id}
                onClick={() => onSelect(player.id)}
                className="w-full text-left px-3 py-2 bg-surface hover:bg-surface-light rounded transition-colors flex items-center gap-3"
              >
                <span className="text-accent font-bold text-sm w-8">
                  #{player.number}
                </span>
                <span className="text-white text-sm flex-1">{player.name}</span>
                <input
                  type="checkbox"
                  checked={onCourtSet.has(player.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const toggleTime = followUpContext?.captureTime ?? captureDefaults.captureTime;
                    void handleToggleOnCourt(player.id, event.target.checked, toggleTime);
                  }}
                  className="accent-accent"
                />
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500">
            <div className="h-px flex-1 bg-panel-border" />
            <span>Bench</span>
            <div className="h-px flex-1 bg-panel-border" />
          </div>

          <div className="space-y-1.5">
            {playersOffCourt.map((player) => (
              <button
                key={player.id}
                onClick={() => onSelect(player.id)}
                className="w-full text-left px-3 py-2 bg-surface hover:bg-surface-light rounded transition-colors flex items-center gap-3"
              >
                <span className="text-accent font-bold text-sm w-8">
                  #{player.number}
                </span>
                <span className="text-white text-sm flex-1">{player.name}</span>
                <input
                  type="checkbox"
                  checked={onCourtSet.has(player.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const toggleTime = followUpContext?.captureTime ?? captureDefaults.captureTime;
                    void handleToggleOnCourt(player.id, event.target.checked, toggleTime);
                  }}
                  className="accent-accent"
                />
              </button>
            ))}
          </div>

          {playersOnCourt.length === 0 && playersOffCourt.length === 0 && (
            <p className="text-xs text-gray-500">No eligible players available.</p>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
