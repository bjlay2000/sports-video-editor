export interface Player {
  id: number;
  name: string;
  number: number;
}

export interface Play {
  id: number;
  timestamp: number;
  player_id: number;
  event_type: string;
  start_time: number;
  end_time: number;
  player_name?: string;
  player_number?: number;
}

export interface Game {
  id: number;
  home_score: number;
  away_score: number;
}

export interface OpponentScoreEvent {
  time: number;
  score: number;
}

export interface ScoreAdjustmentEvent {
  time: number;
  score: number;
}

export type StatType =
  | "2PT"
  | "3PT"
  | "FT"
  | "2PT_MISS"
  | "3PT_MISS"
  | "FT_MISS"
  | "AST"
  | "REB"
  | "STL"
  | "BLK"
  | "TO"
  | "FOUL";

export interface ClipRange {
  start_time: number;
  end_time: number;
}

export interface TimelineMarker {
  id: number;
  time: number;
  event_type: string;
  player_name?: string;
  player_number?: number;
  start_time: number;
  end_time: number;
  label?: string;
}
