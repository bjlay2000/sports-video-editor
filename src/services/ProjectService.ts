import { convertFileSrc } from "@tauri-apps/api/core";
import { exists, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store/appStore";
import { useTimelineStore } from "../store/timelineStore";
import { useVideoStore, type MediaClip } from "../store/videoStore";
import type { Overlay, VideoTrackKeyframe } from "../engine/types";
import type { ScoreAdjustmentEvent, Play, Player, TimelineMarker } from "../store/types";
import type { TimelineSegment } from "../store/timelineStore";

interface ProjectSnapshot {
  format: "svp";
  version: 1;
  savedAt: string;
  app: {
    players: Player[];
    onCourtPlayerIds: number[];
    plays: Play[];
    game: { id: number; home_score: number; away_score: number };
    markers: TimelineMarker[];
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

export class ProjectService {
  static getProjectSignature(snapshot?: ProjectSnapshot): string {
    const source = snapshot ?? this.buildSnapshot();
    const normalized: ProjectSnapshot = {
      ...source,
      savedAt: "",
    };
    return JSON.stringify(normalized);
  }

  static buildSnapshot(): ProjectSnapshot {
    const app = useAppStore.getState();
    const video = useVideoStore.getState();
    const timeline = useTimelineStore.getState();

    return {
      format: "svp",
      version: 1,
      savedAt: new Date().toISOString(),
      app: {
        players: app.players,
        onCourtPlayerIds: app.onCourtPlayerIds,
        plays: app.plays,
        game: app.game,
        markers: app.markers,
        opponentScoreEvents: app.opponentScoreEvents,
        homeScoreEvents: app.homeScoreEvents,
      },
      video: {
        videoPath: video.videoPath,
        clips: video.clips.map(toClipWithoutRuntime),
        activeClipId: video.activeClipId,
        currentTime: video.currentTime,
        duration: video.duration,
        zoomPercent: video.zoomPercent,
        panOffset: video.panOffset,
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
        segments: timeline.segments,
        selectedSegmentId: timeline.selectedSegmentId,
      },
    };
  }

  static async saveProject(path: string): Promise<void> {
    const payload = JSON.stringify(this.buildSnapshot(), null, 2);
    await writeFile(path, toUtf8(payload));
  }

  static async readProject(path: string): Promise<ProjectSnapshot> {
    const bytes = await readFile(path);
    const parsed = JSON.parse(fromUtf8(bytes)) as ProjectSnapshot;
    if (parsed.format !== "svp") {
      throw new Error("Unsupported project file format");
    }
    if (parsed.version !== 1) {
      throw new Error(`Unsupported project version: ${parsed.version}`);
    }
    if (!parsed.app.homeScoreEvents) {
      parsed.app.homeScoreEvents = [{ time: 0, score: 0 }];
    }
    return parsed;
  }

  static async loadProject(path: string): Promise<void> {
    const project = await this.readProject(path);

    const hydratedClips = project.video.clips.map((clip) =>
      withRuntimeClipData(clip),
    );

    const activeClip = hydratedClips.find((clip) => clip.id === project.video.activeClipId) ?? hydratedClips[0] ?? null;

    useAppStore.setState({
      players: project.app.players,
      onCourtPlayerIds: project.app.onCourtPlayerIds,
      plays: project.app.plays,
      game: project.app.game,
      markers: project.app.markers,
      opponentScoreEvents: project.app.opponentScoreEvents,
      homeScoreEvents: project.app.homeScoreEvents,
      pendingStat: null,
      pendingStatTimestamp: null,
      showPlayerModal: false,
      showHighlightModal: false,
      showExportStatsModal: false,
      showAddPlayerModal: false,
    });

    useVideoStore.setState({
      videoPath: activeClip?.path ?? project.video.videoPath ?? null,
      videoSrc: activeClip?.src ?? (project.video.videoPath ? convertFileSrc(project.video.videoPath) : null),
      clips: hydratedClips,
      activeClipId: activeClip?.id ?? null,
      currentTime: project.video.currentTime,
      duration: project.video.duration,
      zoomPercent: project.video.zoomPercent,
      panOffset: project.video.panOffset,
      keyframeMode: project.video.keyframeMode,
      overlays: project.video.overlays,
      videoTrackKeyframes: project.video.videoTrackKeyframes,
      showScoreboardOverlay: project.video.showScoreboardOverlay,
      selectedOverlayIds: [],
      isPlaying: false,
    });

    const activeAssets = activeClip?.assets;

    useTimelineStore.setState({
      pixelsPerSecond: project.timeline.pixelsPerSecond,
      scrollX: project.timeline.scrollX,
      scrollY: project.timeline.scrollY,
      playheadTime: project.timeline.playheadTime,
      segments: project.timeline.segments,
      selectedSegmentId: project.timeline.selectedSegmentId,
      selectedMarkerIds: [],
      thumbnails: activeAssets?.thumbnails ?? [],
      waveformSrc: activeAssets?.waveformSrc ?? null,
      assetsLoading: false,
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
