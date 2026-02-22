import { create } from "zustand";
import { Player, Play, Game, TimelineMarker, ScoreAdjustmentEvent } from "./types";

interface AppState {
  players: Player[];
  onCourtPlayerIds: number[];
  plays: Play[];
  game: Game;
  markers: TimelineMarker[];
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
  setPlayers: (players: Player[]) => void;
  setOnCourtPlayerIds: (ids: number[]) => void;
  toggleOnCourtPlayer: (playerId: number, onCourt: boolean) => void;
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
}

export const useAppStore = create<AppState>((set) => ({
  players: [],
  onCourtPlayerIds: [],
  plays: [],
  game: { id: 1, home_score: 0, away_score: 0 },
  markers: [],
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
  setPlayers: (players) =>
    set((state) => {
      const validIds = new Set(players.map((p) => p.id));
      return {
        players,
        onCourtPlayerIds: state.onCourtPlayerIds.filter((id) => validIds.has(id)),
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
        return has ? {} : { onCourtPlayerIds: [...state.onCourtPlayerIds, playerId] };
      }
      return has
        ? { onCourtPlayerIds: state.onCourtPlayerIds.filter((id) => id !== playerId) }
        : {};
    }),
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
    }),
  updateExportProgress: (percent, status) =>
    set((state) => ({
      exportProgressPercent: Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : state.exportProgressPercent,
      exportProgressStatus: status ?? state.exportProgressStatus,
    })),
}));
