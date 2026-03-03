import { create } from "zustand";
import { Player, Play, Game, TimelineMarker, ScoreAdjustmentEvent, OnCourtInterval } from "./types";
import {
  defaultQualityForContext,
  type ExportQualityContext,
  type QualityProfile,
} from "../services/HardwareDetection";

export interface ExportCompletionStats {
  outputPath: string;
  outputSizeBytes: number;
  totalElapsedMs: number;
  encodeElapsedMs: number;
  encoder: string;
  encoderDisplay: string;
  vendorDisplay: string;
  exportWidth: number;
  exportHeight: number;
  totalDurationSec: number;
  totalFrames: number;
  fps: number;
}

export type { QualityProfile } from "../services/HardwareDetection";

interface AppState {
  players: Player[];
  onCourtPlayerIds: number[];
  plays: Play[];
  game: Game;
  markers: TimelineMarker[];
  onCourtIntervals: OnCourtInterval[];
  opponentScoreEvents: ScoreAdjustmentEvent[];
  homeScoreEvents: ScoreAdjustmentEvent[];
  projectSavedSignature: string | null;
  pendingStat: string | null;
  pendingStatTimestamp: number | null;
  showPlayerModal: boolean;
  showHighlightModal: boolean;
  showExportStatsModal: boolean;
  showAddPlayerModal: boolean;
  isExporting: boolean;
  exportProgressVisible: boolean;
  exportProgressTitle: string;
  exportProgressPercent: number;
  exportProgressStatus: string;
  exportThumbnailUrl: string;
  exportTimeRemaining: string;
  exportCurrentProcess: string;
  exportStartedAt: number;
  exportCompletionStats: ExportCompletionStats | null;
  exportQualityProfile: QualityProfile;
  exportQualityUserSelected: boolean;
  exportQualityInitializedContexts: Record<ExportQualityContext, boolean>;
  exportEstimatedTime: string | null;
  playedPercentRefreshVersion: number;
  setPlayers: (players: Player[]) => void;
  setOnCourtPlayerIds: (ids: number[]) => void;
  toggleOnCourtPlayer: (playerId: number, onCourt: boolean) => void;
  setOnCourtStatusAtTime: (playerId: number, onCourt: boolean, time: number) => void;
  ensurePlayerOnCourtAtTime: (playerId: number, time: number) => void;
  setOnCourtIntervals: (intervals: OnCourtInterval[]) => void;
  resetOnCourtTracking: () => void;
  setPlays: (plays: Play[]) => void;
  addPlay: (play: Play) => void;
  updatePlay: (play: Play) => void;
  removePlay: (id: number) => void;
  setGame: (game: Game) => void;
  setMarkers: (markers: TimelineMarker[]) => void;
  addMarker: (marker: TimelineMarker) => void;
  removeMarker: (id: number) => void;
  updateMarker: (id: number, patch: Partial<TimelineMarker>) => void;
  removeMarkersByIds: (ids: number[]) => void;
  clearMarkersByEventTypes: (eventTypes: string[]) => void;
  logOpponentScoreEvent: (score: number, time: number) => void;
  logHomeScoreEvent: (score: number, time: number) => void;
  resetOpponentScoreEvents: (initialScore?: number) => void;
  resetHomeScoreEvents: (initialScore?: number) => void;
  setProjectSavedSignature: (signature: string | null) => void;
  setPendingStat: (stat: string | null, timestamp?: number | null) => void;
  setShowPlayerModal: (show: boolean) => void;
  setShowHighlightModal: (show: boolean) => void;
  setShowExportStatsModal: (show: boolean) => void;
  setShowAddPlayerModal: (show: boolean) => void;
  setIsExporting: (exporting: boolean) => void;
  setExportProgressVisible: (visible: boolean, title?: string) => void;
  updateExportProgress: (percent: number, status?: string) => void;
  setExportThumbnailUrl: (url: string) => void;
  setExportCurrentProcess: (process: string) => void;
  setExportCompletionStats: (stats: ExportCompletionStats | null) => void;
  setExportQualityProfile: (profile: QualityProfile, source?: "user" | "system") => void;
  initializeExportQualityForContext: (context: ExportQualityContext) => void;
  setExportEstimatedTime: (time: string | null) => void;
  bumpPlayedPercentRefresh: () => void;
  gameResetVersion: number;
  bumpGameResetVersion: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  players: [],
  onCourtPlayerIds: [],
  plays: [],
  game: { id: 1, home_score: 0, away_score: 0 },
  markers: [],
  onCourtIntervals: [],
  opponentScoreEvents: [{ time: 0, score: 0 }],
  homeScoreEvents: [{ time: 0, score: 0 }],
  projectSavedSignature: null,
  pendingStat: null,
  pendingStatTimestamp: null,
  showPlayerModal: false,
  showHighlightModal: false,
  showExportStatsModal: false,
  showAddPlayerModal: false,
  isExporting: false,
  exportProgressVisible: false,
  exportProgressTitle: "",
  exportProgressPercent: 0,
  exportProgressStatus: "",
  exportThumbnailUrl: "",
  exportTimeRemaining: "",
  exportCurrentProcess: "",
  exportStartedAt: 0,
  exportCompletionStats: null,
  exportQualityProfile: "fast" as QualityProfile,
  exportQualityUserSelected: false,
  exportQualityInitializedContexts: {
    highlights: false,
    full: false,
  },
  exportEstimatedTime: null as string | null,
  playedPercentRefreshVersion: 0,
  gameResetVersion: 0,
  setPlayers: (players) =>
    set((state) => {
      const validIds = new Set(players.map((p) => p.id));
      return {
        players,
        onCourtPlayerIds: state.onCourtPlayerIds.filter((id) => validIds.has(id)),
        onCourtIntervals: state.onCourtIntervals.filter((interval) => validIds.has(interval.player_id)),
      };
    }),
  setOnCourtPlayerIds: (ids) =>
    set((state) => {
      const validIds = new Set(state.players.map((p) => p.id));
      return {
        onCourtPlayerIds: Array.from(new Set(ids)).filter((id) => validIds.has(id)),
      };
    }),
  toggleOnCourtPlayer: (playerId, onCourt) =>
    set((state) => {
      const has = state.onCourtPlayerIds.includes(playerId);
      if (onCourt) {
        if (has) return {};
        return {
          onCourtPlayerIds: [...state.onCourtPlayerIds, playerId],
          onCourtIntervals: [
            ...state.onCourtIntervals,
            { player_id: playerId, enter_time: 0, exit_time: null },
          ],
        };
      }
      if (!has) return {};
      const updatedIntervals = [...state.onCourtIntervals];
      for (let i = updatedIntervals.length - 1; i >= 0; i--) {
        if (updatedIntervals[i].player_id === playerId && updatedIntervals[i].exit_time == null) {
          updatedIntervals[i] = { ...updatedIntervals[i], exit_time: updatedIntervals[i].enter_time };
          break;
        }
      }
      return {
        onCourtPlayerIds: state.onCourtPlayerIds.filter((id) => id !== playerId),
        onCourtIntervals: updatedIntervals,
      };
    }),
  setOnCourtStatusAtTime: (playerId, onCourt, time) =>
    set((state) => {
      const normalizedTime = Number.isFinite(time) ? Math.max(0, time) : 0;
      const has = state.onCourtPlayerIds.includes(playerId);
      if (onCourt) {
        if (has) return {};
        return {
          onCourtPlayerIds: [...state.onCourtPlayerIds, playerId],
          onCourtIntervals: [
            ...state.onCourtIntervals,
            { player_id: playerId, enter_time: normalizedTime, exit_time: null },
          ],
        };
      }

      if (!has) return {};
      const updatedIntervals = [...state.onCourtIntervals];
      for (let i = updatedIntervals.length - 1; i >= 0; i--) {
        const interval = updatedIntervals[i];
        if (interval.player_id === playerId && interval.exit_time == null) {
          updatedIntervals[i] = {
            ...interval,
            exit_time: Math.max(interval.enter_time, normalizedTime),
          };
          break;
        }
      }
      return {
        onCourtPlayerIds: state.onCourtPlayerIds.filter((id) => id !== playerId),
        onCourtIntervals: updatedIntervals,
      };
    }),
  ensurePlayerOnCourtAtTime: (playerId, time) =>
    set((state) => {
      if (state.onCourtPlayerIds.includes(playerId)) {
        return {};
      }
      const normalizedTime = Number.isFinite(time) ? Math.max(0, time) : 0;
      return {
        onCourtPlayerIds: [...state.onCourtPlayerIds, playerId],
        onCourtIntervals: [
          ...state.onCourtIntervals,
          { player_id: playerId, enter_time: normalizedTime, exit_time: null },
        ],
      };
    }),
  setOnCourtIntervals: (intervals) => set({ onCourtIntervals: intervals }),
  resetOnCourtTracking: () => set({ onCourtPlayerIds: [], onCourtIntervals: [] }),
  setPlays: (plays) => set({ plays }),
  addPlay: (play) =>
    set((state) => ({ plays: [...state.plays, play] })),
  updatePlay: (play) =>
    set((state) => ({
      plays: state.plays.map((p) => (p.id === play.id ? play : p)),
    })),
  removePlay: (id) =>
    set((state) => ({ plays: state.plays.filter((p) => p.id !== id) })),
  setGame: (game) => set({ game }),
  setMarkers: (markers) => set({ markers }),
  addMarker: (marker) =>
    set((state) => ({ markers: [...state.markers, marker] })),
  removeMarker: (id) =>
    set((state) => ({ markers: state.markers.filter((m) => m.id !== id) })),
  updateMarker: (id, patch) =>
    set((state) => ({
      markers: state.markers.map((marker) =>
        marker.id === id ? { ...marker, ...patch } : marker
      ),
    })),
  removeMarkersByIds: (ids) =>
    set((state) => ({ markers: state.markers.filter((m) => !ids.includes(m.id)) })),
  clearMarkersByEventTypes: (eventTypes) =>
    set((state) => ({
      markers: state.markers.filter((m) => !eventTypes.includes(m.event_type)),
    })),
  logOpponentScoreEvent: (score, time) =>
    set((state) => {
      const normalizedTime = Number.isFinite(time) ? Math.max(0, time) : 0;
      const existing = state.opponentScoreEvents.slice().sort((a, b) => a.time - b.time);
      const last = existing[existing.length - 1];
      if (last && Math.abs(last.time - normalizedTime) < 0.001) {
        existing[existing.length - 1] = { time: normalizedTime, score };
      } else {
        existing.push({ time: normalizedTime, score });
      }
      return { opponentScoreEvents: existing };
    }),
  logHomeScoreEvent: (score, time) =>
    set((state) => {
      const normalizedTime = Number.isFinite(time) ? Math.max(0, time) : 0;
      const existing = state.homeScoreEvents.slice().sort((a, b) => a.time - b.time);
      const last = existing[existing.length - 1];
      if (last && Math.abs(last.time - normalizedTime) < 0.001) {
        existing[existing.length - 1] = { time: normalizedTime, score };
      } else {
        existing.push({ time: normalizedTime, score });
      }
      return { homeScoreEvents: existing };
    }),
  resetOpponentScoreEvents: (initialScore = 0) =>
    set({ opponentScoreEvents: [{ time: 0, score: initialScore }] }),
  resetHomeScoreEvents: (initialScore = 0) =>
    set({ homeScoreEvents: [{ time: 0, score: initialScore }] }),
  setProjectSavedSignature: (signature) => set({ projectSavedSignature: signature }),
  setPendingStat: (stat, timestamp = null) =>
    set({ pendingStat: stat, pendingStatTimestamp: timestamp ?? null }),
  setShowPlayerModal: (show) => set({ showPlayerModal: show }),
  setShowHighlightModal: (show) => set({ showHighlightModal: show }),
  setShowExportStatsModal: (show) => set({ showExportStatsModal: show }),
  setShowAddPlayerModal: (show) => set({ showAddPlayerModal: show }),
  setIsExporting: (exporting) => set({ isExporting: exporting }),
  setExportProgressVisible: (visible, title = "") =>
    set({
      exportProgressVisible: visible,
      exportProgressTitle: title,
      exportProgressPercent: visible ? 0 : 0,
      exportProgressStatus: visible ? "Starting export..." : "",
      exportThumbnailUrl: visible ? useAppStore.getState().exportThumbnailUrl : "",
      exportTimeRemaining: "",
      exportCurrentProcess: "",
      exportStartedAt: visible ? Date.now() : 0,
      exportCompletionStats: visible ? null : null,
    }),
  updateExportProgress: (percent, status) =>
    set((state) => {
      const now = Date.now();
      const clampedPercent = Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : state.exportProgressPercent;

      // Calculate time remaining based on progress rate
      let timeRemaining = state.exportTimeRemaining;
      const startedAt = state.exportStartedAt || now;
      if (clampedPercent > 1 && clampedPercent < 100) {
        const elapsed = (now - startedAt) / 1000;
        if (elapsed > 2 && clampedPercent > 0.5) {
          const pctPerSec = clampedPercent / elapsed;
          const remaining = (100 - clampedPercent) / pctPerSec;
          const h = Math.floor(remaining / 3600);
          const m = Math.floor((remaining % 3600) / 60);
          const s = Math.floor(remaining % 60);
          timeRemaining = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
      } else if (clampedPercent >= 100) {
        timeRemaining = "00:00:00";
      }

      return {
        exportProgressPercent: clampedPercent,
        exportProgressStatus: status ?? state.exportProgressStatus,
        exportTimeRemaining: timeRemaining,
      };
    }),
  setExportThumbnailUrl: (url) => set({ exportThumbnailUrl: url }),
  setExportCurrentProcess: (process) => set({ exportCurrentProcess: process }),
  setExportCompletionStats: (stats) => set({ exportCompletionStats: stats }),
  setExportQualityProfile: (profile, source = "user") =>
    set((state) => ({
      exportQualityProfile: profile,
      exportQualityUserSelected: source === "user" ? true : state.exportQualityUserSelected,
    })),
  initializeExportQualityForContext: (context) =>
    set((state) => {
      if (state.exportQualityInitializedContexts[context]) {
        return {};
      }

      const nextInitialized = {
        ...state.exportQualityInitializedContexts,
        [context]: true,
      };

      if (state.exportQualityUserSelected) {
        return { exportQualityInitializedContexts: nextInitialized };
      }

      return {
        exportQualityProfile: defaultQualityForContext(context),
        exportQualityInitializedContexts: nextInitialized,
      };
    }),
  setExportEstimatedTime: (time) => set({ exportEstimatedTime: time }),
  bumpPlayedPercentRefresh: () =>
    set((state) => ({
      playedPercentRefreshVersion: state.playedPercentRefreshVersion + 1,
    })),
  bumpGameResetVersion: () =>
    set((state) => ({
      gameResetVersion: state.gameResetVersion + 1,
    })),
}));
