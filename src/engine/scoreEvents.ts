import type { ScoreEvent } from "./types";
import type { Play, ScoreAdjustmentEvent } from "../store/types";

const SCORING_POINTS: Record<string, number> = {
  "2PT": 2,
  "3PT": 3,
  "FT": 1,
};

/**
 * Derive unified ScoreEvents from plays (home team) and opponent score
 * adjustments (away team).
 */
export function deriveScoreEvents(
  plays: Play[],
  opponentScoreEvents: ScoreAdjustmentEvent[],
  homeScoreEvents: ScoreAdjustmentEvent[],
): ScoreEvent[] {
  const events: ScoreEvent[] = [];

  // Home team scoring plays
  for (const play of plays) {
    const points = SCORING_POINTS[play.event_type];
    if (points) {
      events.push({ time: play.timestamp, team: "home", delta: points });
    }
  }

  // Away team score adjustments (convert cumulative to deltas)
  const sorted = [...opponentScoreEvents].sort((a, b) => a.time - b.time);
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i].score - sorted[i - 1].score;
    if (delta !== 0) {
      events.push({ time: sorted[i].time, team: "away", delta });
    }
  }

  // Home team manual score adjustments (convert cumulative to deltas)
  const homeSorted = [...homeScoreEvents].sort((a, b) => a.time - b.time);
  for (let i = 1; i < homeSorted.length; i++) {
    const delta = homeSorted[i].score - homeSorted[i - 1].score;
    if (delta !== 0) {
      events.push({ time: homeSorted[i].time, team: "home", delta });
    }
  }

  return events.sort((a, b) => a.time - b.time);
}
