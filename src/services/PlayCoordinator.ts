import { useAppStore } from "../store/appStore";
import { useTimelineStore } from "../store/timelineStore";
import { DatabaseService } from "./DatabaseService";
import type { TimelineMarker } from "../store/types";

const SCORING_POINTS: Record<string, number> = {
  "2PT": 2,
  "3PT": 3,
  "FT": 1,
  "2PT_MISS": 0,
  "3PT_MISS": 0,
  "FT_MISS": 0,
};

const isHighlightMarker = (marker: TimelineMarker) => marker.event_type === "HIGHLIGHT";
const isManualMarker = (marker: TimelineMarker) => marker.event_type === "MARKER";

export class PlayCoordinator {
  static async removePlays(ids: number[]) {
    if (ids.length === 0) return;
    const store = useAppStore.getState();
    const plays = store.plays.filter((play) => ids.includes(play.id));
    if (plays.length === 0) return;

    const statIds = plays.map((play) => play.id);
    let pointsRemoved = 0;

    for (const play of plays) {
      const points = SCORING_POINTS[play.event_type] ?? 0;
      pointsRemoved += points;
      await DatabaseService.deletePlay(play.id);
      store.removePlay(play.id);
      store.removeMarker(play.id);
    }

    const timeline = useTimelineStore.getState();
    timeline.setSelectedMarkerIds(
      timeline.selectedMarkerIds.filter((id) => !statIds.includes(id))
    );

    if (pointsRemoved > 0) {
      const home = Math.max(0, store.game.home_score - pointsRemoved);
      const updated = await DatabaseService.updateScore(home, store.game.away_score);
      store.setGame(updated);
    }
  }

  static async clearAllStatTags() {
    const store = useAppStore.getState();
    const statIds = store.plays.map((play) => play.id);
    if (statIds.length === 0) return;
    await this.removePlays(statIds);
    const reset = await DatabaseService.updateScore(0, 0);
    store.setGame(reset);
    store.resetOpponentScoreEvents(0);
  }

  static clearAllHighlights() {
    const store = useAppStore.getState();
    const highlightIds = store.markers
      .filter((marker) => isHighlightMarker(marker))
      .map((marker) => marker.id);
    if (highlightIds.length === 0) return;
    store.removeMarkersByIds(highlightIds);
    const timeline = useTimelineStore.getState();
    timeline.setSelectedMarkerIds(
      timeline.selectedMarkerIds.filter((id) => !highlightIds.includes(id))
    );
  }

  static async updatePlayWindow(
    id: number,
    timestamp: number,
    startTime: number,
    endTime: number
  ) {
    const updated = await DatabaseService.updatePlayWindow(
      id,
      timestamp,
      startTime,
      endTime
    );
    const store = useAppStore.getState();
    store.updatePlay(updated);
    store.updateMarker(updated.id, {
      time: updated.timestamp,
      start_time: updated.start_time,
      end_time: updated.end_time,
      player_name: updated.player_name ?? undefined,
      player_number: updated.player_number ?? undefined,
    });
  }

  static async refreshPlaysFromDatabase() {
    const store = useAppStore.getState();
    const [plays, game] = await Promise.all([
      DatabaseService.getPlays(),
      DatabaseService.getGame(),
    ]);
    store.setPlays(plays);
    const preserved = store.markers.filter(
      (marker) => isHighlightMarker(marker) || isManualMarker(marker)
    );
    const statMarkers: TimelineMarker[] = plays.map((play) => ({
      id: play.id,
      time: play.timestamp,
      event_type: play.event_type,
      player_name: play.player_name,
      player_number: play.player_number ?? undefined,
      start_time: play.start_time,
      end_time: play.end_time,
    }));
    store.setMarkers([...statMarkers, ...preserved]);
    store.setGame(game);
  }

  static async recalculateScoreFromPlays() {
    const store = useAppStore.getState();
    const totalPoints = store.plays.reduce((sum, play) => sum + (SCORING_POINTS[play.event_type] ?? 0), 0);
    const updated = await DatabaseService.updateScore(totalPoints, store.game.away_score);
    store.setGame(updated);
  }

  static async resetGame() {
    await this.clearAllStatTags();
    this.clearAllHighlights();
    const store = useAppStore.getState();
    const manualMarkerIds = store.markers
      .filter((marker) => isManualMarker(marker))
      .map((marker) => marker.id);
    if (manualMarkerIds.length > 0) {
      store.removeMarkersByIds(manualMarkerIds);
    }
    store.resetOpponentScoreEvents(0);
    const timeline = useTimelineStore.getState();
    timeline.setSelectedMarkerIds([]);
  }
}
