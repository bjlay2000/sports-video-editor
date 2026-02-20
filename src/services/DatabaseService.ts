import { invoke } from "@tauri-apps/api/core";
import { Player, Play, Game } from "../store/types";

export class DatabaseService {
  static async addPlayer(name: string, number: number): Promise<Player> {
    return invoke<Player>("add_player", { name, number });
  }

  static async getPlayers(): Promise<Player[]> {
    return invoke<Player[]>("get_players");
  }

  static async deletePlayer(id: number): Promise<void> {
    return invoke<void>("delete_player", { id });
  }

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

  static async updateScore(homeScore: number, awayScore: number): Promise<Game> {
    return invoke<Game>("update_score", { homeScore, awayScore });
  }

  static async getGame(): Promise<Game> {
    return invoke<Game>("get_game");
  }
}
