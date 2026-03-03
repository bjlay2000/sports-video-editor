import { convertFileSrc } from "@tauri-apps/api/core";
import { exists, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store/appStore";
import { useTimelineStore } from "../store/timelineStore";
import { useVideoStore, type MediaClip } from "../store/videoStore";
import type { Overlay, VideoTrackKeyframe, ViewportState } from "../engine/types";
import type { ScoreAdjustmentEvent, Play, Player, TimelineMarker, OnCourtInterval } from "../store/types";
import type { TimelineSegment } from "../store/timelineStore";
import { DatabaseService } from "./DatabaseService";

/* ── V1 snapshot (legacy, read-only) ── */

interface ProjectSnapshotV1 {
  format: "svp";
  version: 1;
  savedAt: string;
  app: {
    players: Player[];
    onCourtPlayerIds: number[];
    plays: Play[];
    game: { id: number; home_score: number; away_score: number };
    markers: TimelineMarker[];
    onCourtIntervals: OnCourtInterval[];
    opponentScoreEvents: ScoreAdjustmentEvent[];
    homeScoreEvents: ScoreAdjustmentEvent[];
  };
  video: {
    videoPath: string | null;
    clips: Array<Omit<MediaClip, "src">>;
    activeClipId: string | null;
    currentTime: number;
    duration: number;
    zoomPercent: number;
    panOffset: { x: number; y: number };
    keyframeMode: boolean;
    overlays: Overlay[];
    videoTrackKeyframes: VideoTrackKeyframe[];
    showScoreboardOverlay: boolean;
  };
  timeline: {
    pixelsPerSecond: number;
    scrollX: number;
    scrollY: number;
    playheadTime: number;
    segments: TimelineSegment[];
    selectedSegmentId: string | null;
  };
}

/* ── V2 snapshot (metadata-only; mutable data lives in DB) ── */

interface ProjectSnapshotV2 {
  format: "svp";
  version: 2;
  project_id: string;
  savedAt: string;
  video: {
    videoPath: string | null;
    clips: Array<Omit<MediaClip, "src">>;
    activeClipId: string | null;
    currentTime: number;
    duration: number;
    zoomPercent: number;
    panOffset: { x: number; y: number };
    viewport?: ViewportState;
    keyframeMode: boolean;
    overlays: Overlay[];
    videoTrackKeyframes: VideoTrackKeyframe[];
    showScoreboardOverlay: boolean;
  };
  timeline: {
    pixelsPerSecond: number;
    scrollX: number;
    scrollY: number;
    playheadTime: number;
  };
}

type ProjectSnapshot = ProjectSnapshotV1 | ProjectSnapshotV2;

const STAT_EVENT_TYPES = new Set([
  "2PT",
  "3PT",
  "FT",
  "2PT_MISS",
  "3PT_MISS",
  "FT_MISS",
  "AST",
  "REB",
  "STL",
  "BLK",
  "TO",
  "FOUL",
]);

function toUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function fromUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

function toClipWithoutRuntime(clip: MediaClip): Omit<MediaClip, "src"> {
  return {
    id: clip.id,
    path: clip.path,
    name: clip.name,
    duration: clip.duration,
    thumbnail: clip.thumbnail,
    assets: clip.assets,
  };
}

function withRuntimeClipData(clip: Omit<MediaClip, "src">): MediaClip {
  return {
    ...clip,
    src: convertFileSrc(clip.path),
  };
}

function generateProjectId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/* ── Helpers to persist Zustand→DB and DB→Zustand ── */

async function persistMutableDataToDb(): Promise<void> {
  const app = useAppStore.getState();
  const timeline = useTimelineStore.getState();

  // timeline clips
  const dbClips = timeline.segments.map((seg, i) => ({
    id: seg.id,
    start_time: seg.start,
    end_time: seg.end,
    sort_order: i,
  }));
  await DatabaseService.saveTimelineClips(dbClips);

  // score events (no FK dependencies)
  const allEvents = [
    ...app.homeScoreEvents.map((e) => ({ team: "home", time: e.time, score: e.score })),
    ...app.opponentScoreEvents.map((e) => ({ team: "away", time: e.time, score: e.score })),
  ];
  await DatabaseService.saveScoreEvents(allEvents);

  // IMPORTANT: FK ordering — plays and shifts reference players(id).
  // We must clear FK-dependent tables before deleting/replacing players,
  // then re-populate them once the new players are committed.
  await DatabaseService.savePlaysBulk([]);
  await DatabaseService.savePlayerShifts([]);

  // Now safe to replace players (child tables are empty)
  await DatabaseService.savePlayersBulk(app.players);

  // Re-populate FK-dependent tables (players exist now)
  await DatabaseService.savePlaysBulk(app.plays);
  await DatabaseService.savePlayerShifts(
    app.onCourtIntervals.map((iv) => ({
      player_id: iv.player_id,
      enter_time: iv.enter_time,
      exit_time: iv.exit_time,
    })),
  );

  // game score
  await DatabaseService.updateScore(app.game.home_score, app.game.away_score);

  // opponent stats (no FK dependencies)
  await DatabaseService.saveOpponentStats(
    app.opponentPlays.map((p) => ({ timestamp: p.timestamp, event_type: p.event_type })),
  );
}

async function loadMutableDataFromDb(currentTimelinePosition: number) {
  // players
  const players = await DatabaseService.getPlayers();

  // plays (with joined player info)
  const plays = await DatabaseService.getPlays();

  // game
  const game = await DatabaseService.getGame();

  // timeline clips → segments
  const dbClips = await DatabaseService.getTimelineClips();
  const segments: TimelineSegment[] = dbClips.map((c) => ({
    id: c.id,
    start: c.start_time,
    end: c.end_time,
  }));

  // player shifts → onCourtIntervals + onCourtPlayerIds
  const shifts = await DatabaseService.getPlayerShifts();
  const onCourtIntervals: OnCourtInterval[] = shifts.map((s) => ({
    player_id: s.player_id,
    enter_time: s.enter_time,
    exit_time: s.exit_time,
  }));
  const timelinePos = Number.isFinite(currentTimelinePosition)
    ? Math.max(0, currentTimelinePosition)
    : 0;
  const onCourtPlayerIds = Array.from(
    new Set(
      shifts
        .filter((s) => s.enter_time <= timelinePos && (s.exit_time == null || timelinePos < s.exit_time))
        .map((s) => s.player_id),
    ),
  );

  // score events → home/opponent arrays
  const scoreEvents = await DatabaseService.getScoreEvents();
  const homeScoreEvents: ScoreAdjustmentEvent[] = scoreEvents
    .filter((e) => e.team === "home")
    .map((e) => ({ time: e.time, score: e.score }));
  const opponentScoreEvents: ScoreAdjustmentEvent[] = scoreEvents
    .filter((e) => e.team === "away")
    .map((e) => ({ time: e.time, score: e.score }));

  // opponent stats
  const opponentPlays = await DatabaseService.getOpponentStats().catch(() => []);

  // markers from plays
  const statMarkers: TimelineMarker[] = plays.map((play) => ({
    id: play.id,
    time: play.timestamp,
    event_type: play.event_type,
    player_name: play.player_name,
    player_number: play.player_number,
    start_time: play.start_time,
    end_time: play.end_time,
    label: play.event_type,
  }));

  return {
    players,
    plays,
    game,
    segments,
    onCourtIntervals,
    onCourtPlayerIds,
    homeScoreEvents: homeScoreEvents.length ? homeScoreEvents : [{ time: 0, score: 0 }],
    opponentScoreEvents: opponentScoreEvents.length ? opponentScoreEvents : [{ time: 0, score: 0 }],
    opponentPlays: opponentPlays.map((p) => ({ id: p.id, timestamp: p.timestamp, event_type: p.event_type })),
    markers: statMarkers,
  };
}

export class ProjectService {
  /** Current project ID (set on create / open). */
  private static _projectId: string | null = null;

  static get projectId(): string | null {
    return this._projectId;
  }

  static async ensureProjectDbOpen(): Promise<void> {
    if (!this._projectId) {
      this._projectId = generateProjectId();
    }
    await DatabaseService.openProjectDb(this._projectId);
  }

  static getProjectSignature(snapshot?: ProjectSnapshot): string {
    const source = snapshot ?? this.buildSnapshot();
    const normalized = { ...source, savedAt: "" };
    return JSON.stringify(normalized);
  }

  static buildSnapshot(): ProjectSnapshotV2 {
    const video = useVideoStore.getState();
    const timeline = useTimelineStore.getState();

    if (!this._projectId) {
      this._projectId = generateProjectId();
    }

    return {
      format: "svp",
      version: 2,
      project_id: this._projectId,
      savedAt: new Date().toISOString(),
      video: {
        videoPath: video.videoPath,
        clips: video.clips.map(toClipWithoutRuntime),
        activeClipId: video.activeClipId,
        currentTime: video.currentTime,
        duration: video.duration,
        zoomPercent: video.zoomPercent,
        panOffset: video.panOffset,
        viewport: video.viewport,
        keyframeMode: video.keyframeMode,
        overlays: video.overlays,
        videoTrackKeyframes: video.videoTrackKeyframes,
        showScoreboardOverlay: video.showScoreboardOverlay,
      },
      timeline: {
        pixelsPerSecond: timeline.pixelsPerSecond,
        scrollX: timeline.scrollX,
        scrollY: timeline.scrollY,
        playheadTime: timeline.playheadTime,
      },
    };
  }

  static async saveProject(path: string): Promise<void> {
    await this.ensureProjectDbOpen();

    // Persist mutable data to the project DB
    await persistMutableDataToDb();

    // Write metadata-only JSON
    const payload = JSON.stringify(this.buildSnapshot(), null, 2);
    await writeFile(path, toUtf8(payload));
  }

  static async readProject(path: string): Promise<ProjectSnapshot> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (e: any) {
      throw new Error(`Could not read project file: ${e?.message ?? e}`);
    }

    let raw: any;
    try {
      raw = JSON.parse(fromUtf8(bytes));
    } catch (e: any) {
      throw new Error(
        `Project file is not valid JSON. It may be corrupted or from an incompatible version.`
      );
    }

    if (!raw || typeof raw !== "object") {
      throw new Error("Project file is empty or not a valid project.");
    }
    if (raw.format !== "svp") {
      throw new Error(
        `Unsupported project file format${
          raw.format ? `: "${raw.format}"` : " (missing format field)"
        }. This file may be from an older or incompatible version.`
      );
    }
    if (raw.version !== 1 && raw.version !== 2) {
      throw new Error(
        `Unsupported project version: ${raw.version ?? "(none)"}. Only v1 and v2 are supported.`
      );
    }
    const parsed = raw as ProjectSnapshot;

    // V1 defaults
    if (parsed.version === 1) {
      const v1 = parsed as ProjectSnapshotV1;
      if (!v1.app.homeScoreEvents) {
        v1.app.homeScoreEvents = [{ time: 0, score: 0 }];
      }
      if (!Array.isArray(v1.app.players)) v1.app.players = [];
      if (!Array.isArray(v1.app.onCourtPlayerIds)) v1.app.onCourtPlayerIds = [];
      if (!Array.isArray(v1.app.plays)) v1.app.plays = [];
      if (!Array.isArray(v1.app.markers)) v1.app.markers = [];
      if (!Array.isArray(v1.app.onCourtIntervals)) v1.app.onCourtIntervals = [];
      if (!Array.isArray(v1.app.opponentScoreEvents)) {
        v1.app.opponentScoreEvents = [{ time: 0, score: 0 }];
      }
      if (!Array.isArray(v1.video.clips)) v1.video.clips = [];
      if (!Array.isArray(v1.timeline.segments)) v1.timeline.segments = [];
    }

    return parsed;
  }

  static async loadProject(path: string): Promise<void> {
    const project = await this.readProject(path);

    if (project.version === 1) {
      await this.loadV1Project(project as ProjectSnapshotV1, path);
    } else {
      await this.loadV2Project(project as ProjectSnapshotV2);
    }
  }

  /* ── V1 migration: import data into a new per-project DB ── */

  private static async loadV1Project(project: ProjectSnapshotV1, path: string): Promise<void> {
    // Generate a new project ID and open its DB
    this._projectId = generateProjectId();
    await DatabaseService.openProjectDb(this._projectId);

    // Atomic migration: all inserts in a single backend transaction
    const timelineClips = project.timeline.segments.map((seg, i) => ({
      id: seg.id,
      start_time: seg.start,
      end_time: seg.end,
      sort_order: i,
    }));

    const shifts = project.app.onCourtIntervals.map((iv) => ({
      id: 0,
      player_id: iv.player_id,
      enter_time: iv.enter_time,
      exit_time: iv.exit_time,
    }));

    const scoreEvents = [
      ...project.app.homeScoreEvents.map((e) => ({ id: 0, team: "home" as const, time: e.time, score: e.score })),
      ...project.app.opponentScoreEvents.map((e) => ({ id: 0, team: "away" as const, time: e.time, score: e.score })),
    ];

    await DatabaseService.migrateV1ToV2({
      players: project.app.players,
      plays: project.app.plays,
      homeScore: project.app.game.home_score,
      awayScore: project.app.game.away_score,
      timelineClips,
      shifts,
      scoreEvents,
    });

    // Now load from DB (single source of truth) and apply to stores
    await this.applyVideoAndTimelineState(project.video, project.timeline);

    // Rewrite project file as v2 to prevent re-migration (Step 11)
    const v2Snapshot = this.buildSnapshot();
    const payload = JSON.stringify(v2Snapshot, null, 2);
    await writeFile(path, toUtf8(payload));
  }

  /* ── V2 load: open project DB and hydrate from DB ── */

  private static async loadV2Project(project: ProjectSnapshotV2): Promise<void> {
    this._projectId = project.project_id;
    await DatabaseService.openProjectDb(this._projectId);
    await this.applyVideoAndTimelineState(project.video, project.timeline);
  }

  /* ── Shared: hydrate Zustand stores from DB + metadata ── */

  private static async applyVideoAndTimelineState(
    video: ProjectSnapshotV2["video"],
    timeline: ProjectSnapshotV2["timeline"] & { segments?: TimelineSegment[]; selectedSegmentId?: string | null },
  ): Promise<void> {
    const timelinePosition = Number.isFinite(timeline.playheadTime)
      ? Math.max(0, timeline.playheadTime)
      : Number.isFinite(video.currentTime)
        ? Math.max(0, video.currentTime)
        : 0;
    const dbData = await loadMutableDataFromDb(timelinePosition);

    const hydratedClips = video.clips.map((clip) => withRuntimeClipData(clip));
    const activeClip =
      hydratedClips.find((clip) => clip.id === video.activeClipId) ??
      hydratedClips[0] ??
      null;

    const statMarkers = dbData.markers;
    const nonStatMarkers: TimelineMarker[] = [];

    useAppStore.setState({
      players: dbData.players,
      onCourtPlayerIds: dbData.onCourtPlayerIds,
      plays: dbData.plays,
      game: dbData.game,
      markers: [...statMarkers, ...nonStatMarkers],
      onCourtIntervals: dbData.onCourtIntervals,
      opponentScoreEvents: dbData.opponentScoreEvents,
      homeScoreEvents: dbData.homeScoreEvents,
      opponentPlays: dbData.opponentPlays,
      pendingStat: null,
      pendingStatTimestamp: null,
      showPlayerModal: false,
      showHighlightModal: false,
      showExportStatsModal: false,
      showAddPlayerModal: false,
    });

    // Sanitize overlays: JSON.stringify serializes Infinity as null, so restore it
    const sanitizedOverlays = (video.overlays ?? []).map((o) => ({
      ...o,
      startTime: o.startTime == null || !Number.isFinite(o.startTime) ? 0 : o.startTime,
      endTime: o.endTime == null || !Number.isFinite(o.endTime) ? Infinity : o.endTime,
    }));

    useVideoStore.setState({
      videoPath: activeClip?.path ?? video.videoPath ?? null,
      videoSrc: activeClip?.src ?? (video.videoPath ? convertFileSrc(video.videoPath) : null),
      clips: hydratedClips,
      activeClipId: activeClip?.id ?? null,
      currentTime: video.currentTime,
      duration: video.duration,
      zoomPercent: video.zoomPercent,
      panOffset: video.panOffset,
      viewport: video.viewport ?? { zoom: (video.zoomPercent ?? 100) / 100, panX: 0, panY: 0 },
      keyframeMode: video.keyframeMode,
      overlays: sanitizedOverlays,
      videoTrackKeyframes: video.videoTrackKeyframes,
      showScoreboardOverlay: video.showScoreboardOverlay,
      selectedOverlayIds: [],
      isPlaying: false,
    });

    // Step 5: Use DB segments strictly — no fallback to metadata or media
    const segments = dbData.segments;
    const selectedSegmentId = (timeline as { selectedSegmentId?: string | null }).selectedSegmentId ?? null;

    const activeAssets = activeClip?.assets;

    useTimelineStore.setState({
      pixelsPerSecond: timeline.pixelsPerSecond,
      scrollX: timeline.scrollX,
      scrollY: timeline.scrollY,
      playheadTime: timeline.playheadTime,
      segments,
      selectedSegmentId,
      selectedMarkerIds: [],
      thumbnails: activeAssets?.thumbnails ?? [],
      waveformSrc: activeAssets?.waveformSrc ?? null,
      assetsLoading: false,
      _skipNextSegmentInit: segments.length > 0,
    });
  }

  static async videoExists(path: string | null | undefined): Promise<boolean> {
    if (!path) return false;
    try {
      return await exists(path);
    } catch {
      return false;
    }
  }
}
