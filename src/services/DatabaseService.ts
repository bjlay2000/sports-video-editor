import { invoke } from "@tauri-apps/api/core";
import { Player, Play, Game } from "../store/types";

export interface DbTimelineClip {
  id: string;
  start_time: number;
  end_time: number;
  sort_order: number;
}

export interface DbPlayerShift {
  id: number;
  player_id: number;
  enter_time: number;
  exit_time: number | null;
  source?: string | null;
  auto_generated_from_play_id?: string | null;
}

export interface DbScoreEvent {
  id: number;
  team: string;
  time: number;
  score: number;
}

export interface StatRecordResult {
  play: Play;
  game: Game;
}

export interface PlayerPlayedPercentage {
  player_id: number;
  played_seconds: number;
  total_duration: number;
  percent_played: number;
}

export interface Roster {
  roster_id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface RosterPlayer {
  roster_player_id: number;
  roster_id: number;
  name: string;
  number: number;
}

export interface DbOpponentStat {
  id: number;
  timestamp: number;
  event_type: string;
}

export class DatabaseService {
  /* ── project DB lifecycle ── */

  static async openProjectDb(projectId: string): Promise<string> {
    return invoke<string>("open_project_db", { projectId });
  }

  /* ── players ── */

  static async addPlayer(name: string, number: number): Promise<Player> {
    return invoke<Player>("add_player", { name, number });
  }

  static async getPlayers(): Promise<Player[]> {
    return invoke<Player[]>("get_players");
  }

  static async deletePlayer(id: number): Promise<void> {
    return invoke<void>("delete_player", { id });
  }

  static async savePlayersBulk(players: Player[]): Promise<void> {
    return invoke<void>("save_players_bulk", { players });
  }

  /* ── plays ── */

  static async addPlay(
    timestamp: number,
    playerId: number,
    eventType: string,
    startTime: number,
    endTime: number
  ): Promise<Play> {
    return invoke<Play>("add_play", {
      timestamp,
      playerId,
      eventType,
      startTime,
      endTime,
    });
  }

  static async getPlays(): Promise<Play[]> {
    return invoke<Play[]>("get_plays");
  }

  static async getPlaysByType(eventType: string): Promise<Play[]> {
    return invoke<Play[]>("get_plays_by_type", { eventType });
  }

  static async deletePlay(id: number): Promise<void> {
    return invoke<void>("delete_play", { id });
  }

  static async updatePlayWindow(
    id: number,
    timestamp: number,
    startTime: number,
    endTime: number
  ): Promise<Play> {
    return invoke<Play>("update_play_window", {
      id,
      timestamp,
      startTime,
      endTime,
    });
  }

  static async updatePlayEventAndPlayer(
    id: number,
    eventType: string | null,
    playerId: number | null
  ): Promise<Play> {
    return invoke<Play>("update_play_event_and_player", { id, eventType, playerId });
  }

  static async savePlaysBulk(plays: Play[]): Promise<void> {
    return invoke<void>("save_plays_bulk", { plays });
  }

  /* ── game ── */

  static async updateScore(homeScore: number, awayScore: number): Promise<Game> {
    return invoke<Game>("update_score", { homeScore, awayScore });
  }

  static async getGame(): Promise<Game> {
    return invoke<Game>("get_game");
  }

  /* ── timeline clips ── */

  static async saveTimelineClips(clips: DbTimelineClip[]): Promise<void> {
    return invoke<void>("save_timeline_clips", { clips });
  }

  static async getTimelineClips(): Promise<DbTimelineClip[]> {
    return invoke<DbTimelineClip[]>("get_timeline_clips");
  }

  /* ── player shifts ── */

  static async savePlayerShifts(shifts: Array<{ player_id: number; enter_time: number; exit_time: number | null; source?: string; auto_generated_from_play_id?: string | null }>): Promise<void> {
    const mapped = shifts.map((s) => ({ id: 0, source: "manual_sub", auto_generated_from_play_id: null, ...s }));
    return invoke<void>("save_player_shifts", { shifts: mapped });
  }

  static async getPlayerShifts(): Promise<DbPlayerShift[]> {
    return invoke<DbPlayerShift[]>("get_player_shifts");
  }

  /* ── score events ── */

  static async saveScoreEvents(events: Array<{ team: string; time: number; score: number }>): Promise<void> {
    const mapped = events.map((e) => ({ id: 0, ...e }));
    return invoke<void>("save_score_events", { events: mapped });
  }

  static async getScoreEvents(): Promise<DbScoreEvent[]> {
    return invoke<DbScoreEvent[]>("get_score_events");
  }

  /* ── opponent stats ── */

  static async saveOpponentStats(stats: Array<{ timestamp: number; event_type: string }>): Promise<void> {
    const mapped = stats.map((s) => ({ id: 0, ...s }));
    return invoke<void>("save_opponent_stats", { stats: mapped });
  }

  static async getOpponentStats(): Promise<DbOpponentStat[]> {
    return invoke<DbOpponentStat[]>("get_opponent_stats");
  }

  static async addOpponentStat(timestamp: number, eventType: string): Promise<DbOpponentStat> {
    return invoke<DbOpponentStat>("add_opponent_stat", { timestamp, eventType });
  }

  static async deleteOpponentStat(id: number): Promise<void> {
    return invoke<void>("delete_opponent_stat", { id });
  }

  /* ── crash safety ── */

  static async closeOpenShifts(projectDuration: number): Promise<void> {
    return invoke<void>("close_open_shifts", { projectDuration });
  }

  /* ── atomic v1→v2 migration ── */

  static async migrateV1ToV2(data: {
    players: Player[];
    plays: Play[];
    homeScore: number;
    awayScore: number;
    timelineClips: DbTimelineClip[];
    shifts: DbPlayerShift[];
    scoreEvents: DbScoreEvent[];
  }): Promise<void> {
    return invoke<void>("migrate_v1_to_v2", data);
  }

  /* ── transactional stat recording ── */

  static async recordStatWithSideEffects(params: {
    timestamp: number;
    playerId: number;
    eventType: string;
    startTime: number;
    endTime: number;
    scoreDelta: number | null;
    ensureOnCourt: boolean;
    courtEnterTime: number;
  }): Promise<StatRecordResult> {
    return invoke<StatRecordResult>("record_stat_with_side_effects", params);
  }

  /* ── DB-derived % played ── */

  static async getPlayedPercentages(): Promise<PlayerPlayedPercentage[]> {
    return invoke<PlayerPlayedPercentage[]>("get_played_percentages");
  }

  /* ── dev diagnostics ── */

  static async explainQueryPlans(): Promise<string[]> {
    return invoke<string[]>("explain_query_plans");
  }

  /* ── global roster templates ── */

  static async createRoster(name: string): Promise<Roster> {
    return invoke<Roster>("create_roster", { name });
  }

  static async deleteRoster(rosterId: number): Promise<void> {
    return invoke<void>("delete_roster", { rosterId });
  }

  static async getRosters(): Promise<Roster[]> {
    return invoke<Roster[]>("get_rosters");
  }

  static async getRosterPlayers(rosterId: number): Promise<RosterPlayer[]> {
    return invoke<RosterPlayer[]>("get_roster_players", { rosterId });
  }

  static async saveRosterPlayers(
    rosterId: number,
    players: Array<{ name: string; number: number }>,
  ): Promise<void> {
    return invoke<void>("save_roster_players", { rosterId, players });
  }
}
