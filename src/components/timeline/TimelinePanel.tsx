import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type WheelEvent as ReactWheelEvent,
  type UIEvent as ReactUIEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ChangeEvent,
} from "react";
import { TimelineRenderer } from "./TimelineRenderer";
import { useTimelineStore } from "../../store/timelineStore";
import { useVideoStore } from "../../store/videoStore";
import { useAppStore } from "../../store/appStore";
import { videoEngine } from "../../services/VideoEngine";
import type { TimelineMarker } from "../../store/types";
import { PlayCoordinator } from "../../services/PlayCoordinator";
import { DatabaseService } from "../../services/DatabaseService";
import { ProjectService } from "../../services/ProjectService";

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const hundredths = Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}.${hundredths}`;
};

const formatMarkerLabel = (eventType: string) => {
  switch (eventType) {
    case "2PT":
    case "3PT":
    case "FT":
      return `${eventType} +`;
    case "2PT_MISS":
      return "2PT x";
    case "3PT_MISS":
      return "3PT x";
    case "FT_MISS":
      return "FT x";
    default:
      return eventType;
  }
};

const getRecentPlayStyle = (eventType: string) => {
  switch (eventType) {
    case "2PT":
    case "3PT":
    case "FT":
      return {
        borderClass: "border-green-400/20",
        statTextClass: "text-green-300",
      };
    case "2PT_MISS":
    case "3PT_MISS":
    case "FT_MISS":
      return {
        borderClass: "border-gray-300/15",
        statTextClass: "text-gray-300",
      };
    case "AST":
      return {
        borderClass: "border-blue-400/20",
        statTextClass: "text-blue-300",
      };
    case "REB":
      return {
        borderClass: "border-yellow-400/20",
        statTextClass: "text-yellow-300",
      };
    case "STL":
      return {
        borderClass: "border-purple-400/20",
        statTextClass: "text-purple-300",
      };
    case "BLK":
      return {
        borderClass: "border-red-400/20",
        statTextClass: "text-red-300",
      };
    case "TO":
      return {
        borderClass: "border-orange-400/20",
        statTextClass: "text-orange-300",
      };
    case "FOUL":
      return {
        borderClass: "border-rose-400/20",
        statTextClass: "text-rose-300",
      };
    default:
      return {
        borderClass: "border-white/10",
        statTextClass: "text-gray-300",
      };
  }
};

const ALL_STAT_TYPES = [
  "2PT", "2PT_MISS", "3PT", "3PT_MISS", "FT", "FT_MISS",
  "AST", "REB", "STL", "BLK", "TO", "FOUL",
] as const;

export function TimelinePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recentListRef = useRef<HTMLDivElement>(null);
  const playheadDraggingRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [recentViewportHeight, setRecentViewportHeight] = useState(210);
  const [recentPlaysScrollTop, setRecentPlaysScrollTop] = useState(0);
  const [filterPlayers, setFilterPlayers] = useState<string[]>([]);
  const [filterStats, setFilterStats] = useState<string[]>([]);
  const [playerFilterOpen, setPlayerFilterOpen] = useState(false);
  const [statsFilterOpen, setStatsFilterOpen] = useState(false);
  const [editingMarkerId, setEditingMarkerId] = useState<number | null>(null);
  const [editMode, setEditMode] = useState<"menu" | "type" | "player" | null>(null);
  const lastVideoPathRef = useRef<string | null>(null);

  const pixelsPerSecond = useTimelineStore((s) => s.pixelsPerSecond);
  const setPixelsPerSecond = useTimelineStore((s) => s.setPixelsPerSecond);
  const scrollX = useTimelineStore((s) => s.scrollX);
  const setScrollX = useTimelineStore((s) => s.setScrollX);
  const playheadTime = useTimelineStore((s) => s.playheadTime);
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime);
  const thumbnails = useTimelineStore((s) => s.thumbnails);
  const assetsLoading = useTimelineStore((s) => s.assetsLoading);
  const thumbnailsGenerating = useTimelineStore((s) => s.thumbnailsGenerating);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);
  const selectedMarkerIds = useTimelineStore((s) => s.selectedMarkerIds);
  const setSelectedMarkerIds = useTimelineStore((s) => s.setSelectedMarkerIds);
  const toggleMarkerSelection = useTimelineStore((s) => s.toggleMarkerSelection);
  const clearSelection = useTimelineStore((s) => s.clearSelection);
  const segments = useTimelineStore((s) => s.segments);
  const initializeSegments = useTimelineStore((s) => s.initializeSegments);
  const splitSegment = useTimelineStore((s) => s.splitSegment);
  const removeSegment = useTimelineStore((s) => s.removeSegment);
  const undoRemoveSegment = useTimelineStore((s) => s.undoRemoveSegment);
  const selectedSegmentId = useTimelineStore((s) => s.selectedSegmentId);
  const setSelectedSegmentId = useTimelineStore((s) => s.setSelectedSegmentId);
  const skipNextSegmentInit = useTimelineStore((s) => s._skipNextSegmentInit);
  const setSkipNextSegmentInit = useTimelineStore((s) => s.setSkipNextSegmentInit);
  const duration = useVideoStore((s) => s.duration);
  const currentTime = useVideoStore((s) => s.currentTime);
  const setCurrentTime = useVideoStore((s) => s.setCurrentTime);
  const zoomPercent = useVideoStore((s) => s.zoomPercent);
  const setZoomPercent = useVideoStore((s) => s.setZoomPercent);
  const keyframeMode = useVideoStore((s) => s.keyframeMode);
  const toggleKeyframeMode = useVideoStore((s) => s.toggleKeyframeMode);
  const videoPath = useVideoStore((s) => s.videoPath);
  const videoSrc = useVideoStore((s) => s.videoSrc);
  const isPlaying = useVideoStore((s) => s.isPlaying);
  const setIsPlaying = useVideoStore((s) => s.setIsPlaying);
  const addTextOverlay = useVideoStore((s) => s.addTextOverlay);
  const addImageOverlay = useVideoStore((s) => s.addImageOverlay);
  const updateOverlay = useVideoStore((s) => s.updateOverlay);
  const overlaySelection = useVideoStore((s) => s.selectedOverlayIds);
  const removeOverlays = useVideoStore((s) => s.removeOverlays);
  const bringSelectionForward = useVideoStore((s) => s.bringSelectionForward);
  const sendSelectionBackward = useVideoStore((s) => s.sendSelectionBackward);
  const hasOverlaySelection = overlaySelection.length > 0;
  const markers = useAppStore((s) => s.markers);
  const addMarker = useAppStore((s) => s.addMarker);
  const removeMarker = useAppStore((s) => s.removeMarker);
  const removeMarkersByIds = useAppStore((s) => s.removeMarkersByIds);
  const updateMarker = useAppStore((s) => s.updateMarker);
  const bumpPlayedPercentRefresh = useAppStore((s) => s.bumpPlayedPercentRefresh);
  const players = useAppStore((s) => s.players);
  const addOpponentPlay = useAppStore((s) => s.addOpponentPlay);

  const persistSegmentsToDb = useCallback(async () => {
    await ProjectService.ensureProjectDbOpen();
    const segs = useTimelineStore.getState().segments;
    const dbClips = segs.map((seg, i) => ({
      id: seg.id,
      start_time: seg.start,
      end_time: seg.end,
      sort_order: i,
    }));
    await DatabaseService.saveTimelineClips(dbClips);
    bumpPlayedPercentRefresh();
  }, [bumpPlayedPercentRefresh]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (containerRef.current) {
      setContainerWidth(containerRef.current.clientWidth);
    }
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (recentListRef.current) {
        setRecentViewportHeight(recentListRef.current.clientHeight);
      }
    });
    if (recentListRef.current) {
      setRecentViewportHeight(recentListRef.current.clientHeight);
      observer.observe(recentListRef.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!videoPath || duration <= 0) {
      if (!videoPath) {
        lastVideoPathRef.current = null;
        initializeSegments(0);
      }
      return;
    }
    // When loading from a project, segments are already DB-hydrated — skip init
    if (skipNextSegmentInit) {
      lastVideoPathRef.current = videoPath;
      setSkipNextSegmentInit(false);
      return;
    }
    // Step 5: Only init segments for genuinely new media (no DB data loaded)
    if (!segments.length && lastVideoPathRef.current !== videoPath) {
      initializeSegments(duration);
      lastVideoPathRef.current = videoPath;
      setCurrentTime(0);
      setPlayheadTime(0);
      videoEngine.seek(0);
    }
  }, [duration, videoPath, segments.length, initializeSegments, setCurrentTime, setPlayheadTime, skipNextSegmentInit, setSkipNextSegmentInit]);

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        const factor = 1 + delta * 0.15;
        setPixelsPerSecond(pixelsPerSecond * factor);
      } else {
        setScrollX(Math.max(0, scrollX + e.deltaY + e.deltaX));
      }
    },
    [pixelsPerSecond, scrollX, setPixelsPerSecond, setScrollX]
  );

  const handleScroll = (e: ReactUIEvent<HTMLDivElement>) => {
    setScrollX(e.currentTarget.scrollLeft);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollX;
    }
  }, [scrollX]);

  const projectDuration = useMemo(() => {
    if (!segments.length) {
      return duration;
    }
    return segments.reduce((total, segment) => total + Math.max(0, segment.end - segment.start), 0);
  }, [segments, duration]);

  const sourceToProject = useCallback(
    (sourceTime: number) => {
      if (!segments.length || duration <= 0) {
        return Math.max(0, Math.min(sourceTime, duration));
      }
      let accum = 0;
      for (const segment of segments) {
        const segDuration = Math.max(0, segment.end - segment.start);
        if (segDuration <= 0) continue;
        if (sourceTime < segment.start) {
          return accum;
        }
        if (sourceTime <= segment.end) {
          return accum + (sourceTime - segment.start);
        }
        accum += segDuration;
      }
      return accum;
    },
    [segments, duration]
  );

  const projectToSource = useCallback(
    (projectTime: number) => {
      if (!segments.length || duration <= 0) {
        return Math.max(0, Math.min(projectTime, duration));
      }
      let remaining = projectTime;
      for (const segment of segments) {
        const segDuration = Math.max(0, segment.end - segment.start);
        if (segDuration <= 0) continue;
        if (remaining <= segDuration) {
          return segment.start + remaining;
        }
        remaining -= segDuration;
      }
      const last = segments[segments.length - 1];
      return last ? last.end : 0;
    },
    [segments, duration]
  );

  const isTimeWithinSegments = useCallback(
    (time: number) => {
      if (!segments.length || duration <= 0) {
        return duration <= 0 ? true : time >= 0 && time <= duration;
      }
      return segments.some((segment) => time >= segment.start && time <= segment.end);
    },
    [segments, duration]
  );

  const projectPlayhead = useMemo(() => {
    if (duration <= 0) {
      return 0;
    }
    const total = projectDuration || duration;
    return Math.min(total, sourceToProject(playheadTime));
  }, [duration, playheadTime, projectDuration, sourceToProject]);

  // Auto-center timeline when playhead goes off-screen during playback
  useEffect(() => {
    if (!isPlaying || playheadDraggingRef.current) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollWidth = scroller.scrollWidth;
    if (scrollWidth <= containerWidth) return;
    const timelineDur = projectDuration || duration || 1;
    const ratio = projectPlayhead / timelineDur;
    const playheadPixel = ratio * scrollWidth;
    const currentScrollX = scroller.scrollLeft;
    if (playheadPixel < currentScrollX || playheadPixel > currentScrollX + containerWidth) {
      const target = playheadPixel - containerWidth / 2;
      const clamped = Math.max(0, Math.min(target, scrollWidth - containerWidth));
      scroller.scrollLeft = clamped;
      setScrollX(clamped);
    }
  }, [isPlaying, playheadTime, projectPlayhead, projectDuration, duration, containerWidth, setScrollX]);

  const handleSeek = useCallback(
    (projectTime: number) => {
      if (duration <= 0) return;
      const total = projectDuration || duration;
      const clampedProject = Math.max(0, Math.min(projectTime, total));
      const sourceTime = projectToSource(clampedProject);
      setPlayheadTime(sourceTime);
      setCurrentTime(sourceTime);
      videoEngine.seek(sourceTime);
    },
    [duration, projectDuration, projectToSource, setCurrentTime, setPlayheadTime]
  );

  const getMarkerAnchorTime = (marker: TimelineMarker) =>
    typeof marker.start_time === "number" && !Number.isNaN(marker.start_time)
      ? marker.start_time
      : marker.time;

  const handleMarkerClick = (marker: TimelineMarker) => {
    const anchor = getMarkerAnchorTime(marker);
    if (!isTimeWithinSegments(anchor)) return;
    const projectTime = sourceToProject(anchor);
    handleSeek(projectTime);
  };

  const handleRecentPlayClick = (marker: TimelineMarker) => {
    const preferredStart =
      typeof marker.start_time === "number" && Number.isFinite(marker.start_time)
        ? marker.start_time
        : marker.time;
    const anchor = isTimeWithinSegments(preferredStart) ? preferredStart : marker.time;
    const projectTime = sourceToProject(anchor);
    handleSelectMarker(marker.id, false);
    handleSeek(projectTime);
    requestAnimationFrame(() => {
      handleCenterOnPlayhead();
    });
  };

  const handleSelectMarker = (markerId: number, additive: boolean) => {
    toggleMarkerSelection(markerId, additive);
  };

  const handleAddMarker = () => {
    const markerId = Date.now();
    addMarker({
      id: markerId,
      time: currentTime,
      event_type: "MARKER",
      start_time: currentTime,
      end_time: currentTime,
      label: `Marker ${formatClock(currentTime)}`,
    });
  };

  const handleAddTextOverlay = () => {
    if (!videoSrc) return;
    const id = addTextOverlay();
    const next = window.prompt("Overlay text", "Custom Text");
    if (next && next.trim()) {
      updateOverlay(id, { text: next.trim() });
    }
  };

  const handleTriggerImageOverlay = () => {
    if (!videoSrc) return;
    imageInputRef.current?.click();
  };

  const handleZOrderPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleSendBackwardClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hasOverlaySelection) return;
    sendSelectionBackward();
  };

  const handleBringForwardClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hasOverlaySelection) return;
    bringSelectionForward();
  };

  const handleImageOverlaySelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        addImageOverlay(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAddHighlight = () => {
    const markerId = Date.now();
    addMarker({
      id: markerId,
      time: currentTime,
      event_type: "HIGHLIGHT",
      start_time: Math.max(0, currentTime - 3),
      end_time: Math.min(duration, currentTime + 3),
      label: "Highlight",
    });
  };

  const handleRemoveHighlight = () => {
    const highlight = [...markers].reverse().find((m) => m.event_type === "HIGHLIGHT");
    if (highlight) {
      removeMarker(highlight.id);
    }
  };

  const handleRenameMarker = (marker: TimelineMarker) => {
    if (marker.event_type !== "MARKER") {
      return;
    }
    const currentLabel = marker.label ?? "Marker";
    const next = window.prompt("Rename marker", currentLabel)?.trim();
    if (!next) return;
    updateMarker(marker.id, { label: next });
  };

  const recentTimelinePlays = markers
    .filter((marker) => marker.event_type !== "HIGHLIGHT" && marker.event_type !== "MARKER")
    .filter((marker) => isTimeWithinSegments(marker.time))
    .sort((a, b) => b.time - a.time || b.id - a.id);

  const uniquePlayerNames = useMemo(() => {
    const names = new Set<string>();
    for (const m of recentTimelinePlays) {
      if (m.player_name) names.add(m.player_name);
    }
    return [...names].sort();
  }, [recentTimelinePlays]);

  const uniqueStatTypes = useMemo(() => {
    const types = new Set<string>();
    for (const m of recentTimelinePlays) {
      types.add(m.event_type);
    }
    return [...types].sort();
  }, [recentTimelinePlays]);

  const filteredRecentPlays = useMemo(() => {
    return recentTimelinePlays.filter((m) => {
      if (filterPlayers.length > 0 && !filterPlayers.includes(m.player_name ?? "")) return false;
      if (filterStats.length > 0 && !filterStats.includes(m.event_type)) return false;
      return true;
    });
  }, [recentTimelinePlays, filterPlayers, filterStats]);

  const hasActiveFilter = filterPlayers.length > 0 || filterStats.length > 0;

  const filteredMarkers = useMemo(() => {
    if (!hasActiveFilter) return markers;
    return markers.filter((m) => {
      // Always show highlights and manual markers regardless of filter
      if (m.event_type === "HIGHLIGHT" || m.event_type === "MARKER") return true;
      if (filterPlayers.length > 0 && !filterPlayers.includes(m.player_name ?? "")) return false;
      if (filterStats.length > 0 && !filterStats.includes(m.event_type)) return false;
      return true;
    });
  }, [markers, filterPlayers, filterStats, hasActiveFilter]);

  const recentRowHeight = 56;
  const recentViewportSafeHeight = Math.max(1, recentViewportHeight);
  const recentOverscanRows = 6;
  const recentStartIndex = Math.max(0, Math.floor(recentPlaysScrollTop / recentRowHeight) - recentOverscanRows);
  const recentEndIndex = Math.min(
    filteredRecentPlays.length,
    Math.ceil((recentPlaysScrollTop + recentViewportSafeHeight) / recentRowHeight) + recentOverscanRows,
  );
  const visibleRecentTimelinePlays = filteredRecentPlays.slice(recentStartIndex, recentEndIndex);

  const previewClipRef = useRef<{ clips: Array<{ start: number; end: number }>; index: number; rafId: number | null } | null>(null);

  const stopPreview = useCallback(() => {
    const state = previewClipRef.current;
    if (state?.rafId != null) cancelAnimationFrame(state.rafId);
    previewClipRef.current = null;
    videoEngine.pause();
    setIsPlaying(false);
  }, [setIsPlaying]);

  const handlePreviewStats = useCallback(() => {
    if (!hasActiveFilter || filteredRecentPlays.length === 0) return;

    const clips = filteredRecentPlays
      .filter((m) => typeof m.start_time === "number" && typeof m.end_time === "number")
      .map((m) => ({ start: m.start_time!, end: m.end_time! }))
      .sort((a, b) => a.start - b.start);

    if (clips.length === 0) return;

    // If already previewing, stop
    if (previewClipRef.current) {
      stopPreview();
      return;
    }

    const state = { clips, index: 0, rafId: null as number | null };
    previewClipRef.current = state;

    const playNextClip = () => {
      const s = previewClipRef.current;
      if (!s || s.index >= s.clips.length) {
        stopPreview();
        return;
      }
      const clip = s.clips[s.index];
      videoEngine.seek(clip.start);
      setCurrentTime(clip.start);
      setPlayheadTime(clip.start);
      void videoEngine.play();
      setIsPlaying(true);

      const watchEnd = () => {
        const cur = previewClipRef.current;
        if (!cur) return;
        const t = videoEngine.getCurrentTime();
        if (t >= cur.clips[cur.index].end) {
          cur.index += 1;
          playNextClip();
          return;
        }
        cur.rafId = requestAnimationFrame(watchEnd);
      };
      state.rafId = requestAnimationFrame(watchEnd);
    };

    playNextClip();
  }, [hasActiveFilter, filteredRecentPlays, stopPreview, setCurrentTime, setPlayheadTime, setIsPlaying]);

  // Clean up preview on unmount
  useEffect(() => () => { stopPreview(); }, [stopPreview]);

  const handleDeleteSelected = async () => {
    if (selectedSegmentId) {
      if (segments.length <= 1) return;
      removeSegment(selectedSegmentId);
      await persistSegmentsToDb();
      return;
    }

    if (overlaySelection.length > 0) {
      console.log("[delete] about to remove, selectedOverlayIds:", overlaySelection);
      removeOverlays(overlaySelection);
    }
    if (selectedMarkerIds.length === 0) return;
    const selected = markers.filter((marker) => selectedMarkerIds.includes(marker.id));
    const statIds = selected
      .filter((marker) => marker.event_type !== "HIGHLIGHT" && marker.event_type !== "MARKER")
      .map((marker) => marker.id);
    const highlightIds = selected
      .filter((marker) => marker.event_type === "HIGHLIGHT" || marker.event_type === "MARKER")
      .map((marker) => marker.id);
    if (statIds.length > 0) {
      await PlayCoordinator.removePlays(statIds);
    }
    if (highlightIds.length > 0) {
      removeMarkersByIds(highlightIds);
    }
    clearSelection();
  };

  const handleUndoSegmentDelete = () => {
    undoRemoveSegment();
    void persistSegmentsToDb();
  };

  const [resizeState, setResizeState] = useState<{
    markerId: number;
    edge: "start" | "end";
  } | null>(null);

  const handleResizeStart = (markerId: number, edge: "start" | "end") => {
    setResizeState({ markerId, edge });
    if (!selectedMarkerIds.includes(markerId)) {
      setSelectedMarkerIds([markerId]);
    }
  };

  const applyResize = (markerId: number, edge: "start" | "end", time: number) => {
    const marker = markers.find((m) => m.id === markerId);
    if (!marker) return;
    const clamped = Math.max(0, Math.min(time, duration));
    if (edge === "start") {
      const nextStart = Math.min(clamped, marker.end_time - 0.1);
      updateMarker(markerId, { start_time: nextStart });
    } else {
      const nextEnd = Math.max(clamped, marker.start_time + 0.1);
      updateMarker(markerId, { end_time: nextEnd });
    }
  };

  const handleResizeDrag = (time: number) => {
    if (!resizeState) return;
    applyResize(resizeState.markerId, resizeState.edge, time);
  };

  const handleResizeEnd = async () => {
    if (!resizeState) return;
    const marker = markers.find((m) => m.id === resizeState.markerId);
    setResizeState(null);
    if (!marker) return;
    if (marker.event_type === "HIGHLIGHT" || marker.event_type === "MARKER") {
      return;
    }
    await PlayCoordinator.updatePlayWindow(
      marker.id,
      marker.time,
      marker.start_time,
      marker.end_time
    );
  };

  const handleAddCutPoint = () => {
    if (!segments.length) return;
    splitSegment(playheadTime);
    void persistSegmentsToDb();
  };

  const handleDeleteSegment = (segmentId: string) => {
    if (segments.length <= 1) return;
    removeSegment(segmentId);
    void persistSegmentsToDb();
  };

  useEffect(() => {
    if (!segments.length || duration <= 0) return;
    const epsilon = 0.02;
    const within = segments.some(
      (segment) => currentTime >= segment.start - epsilon && currentTime <= segment.end + epsilon
    );
    if (within) return;
    const next = segments.find((segment) => segment.start > currentTime);
    if (next) {
      if (Math.abs(currentTime - next.start) > epsilon) {
        setCurrentTime(next.start);
        setPlayheadTime(next.start);
        videoEngine.seek(next.start);
      }
      return;
    }
    const prev = [...segments].reverse().find((segment) => segment.end < currentTime - epsilon);
    const fallback = prev ? prev.end : segments[0].start;
    if (isPlaying) {
      videoEngine.pause();
      setIsPlaying(false);
    }
    if (Math.abs(currentTime - fallback) > epsilon) {
      setCurrentTime(fallback);
      setPlayheadTime(fallback);
      videoEngine.seek(fallback);
    }
  }, [segments, currentTime, duration, isPlaying, setCurrentTime, setPlayheadTime, setIsPlaying]);

  const handleCenterOnPlayhead = () => {
    if (!scrollRef.current) return;
    const scrollWidth = scrollRef.current.scrollWidth;
    const timelineDur = projectDuration || duration || 1;
    const centerRatio = playheadTime / timelineDur;
    const target = centerRatio * scrollWidth;
    const offset = target - containerWidth / 2;
    const clamped = Math.max(0, Math.min(offset, scrollWidth - containerWidth));
    scrollRef.current.scrollTo({ left: clamped, behavior: "smooth" });
    setScrollX(clamped);
  };

  const handlePlayheadDragStart = useCallback(() => {
    playheadDraggingRef.current = true;
  }, []);

  const handlePlayheadDragEnd = useCallback(() => {
    playheadDraggingRef.current = false;
  }, []);

  const handlePlayheadDragMove = useCallback(
    (clientX: number) => {
      if (!playheadDraggingRef.current) return;
      const container = containerRef.current;
      const scroller = scrollRef.current;
      if (!container || !scroller) return;

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;

      const edgeZoneWidth = rect.width * 0.1;
      const leftTrigger = rect.left + edgeZoneWidth;
      const rightTrigger = rect.right - edgeZoneWidth;

      let edgeDelta = 0;
      let distanceIntoZone = 0;
      if (clientX < leftTrigger) {
        edgeDelta = clientX - leftTrigger;
        distanceIntoZone = leftTrigger - clientX;
      } else if (clientX > rightTrigger) {
        edgeDelta = clientX - rightTrigger;
        distanceIntoZone = clientX - rightTrigger;
      }

      if (edgeDelta === 0) return;

      const clampedDistanceIntoZone = Math.max(0, Math.min(edgeZoneWidth, distanceIntoZone));
      const proximityRatio = edgeZoneWidth > 0 ? clampedDistanceIntoZone / edgeZoneWidth : 0;

      // User request:
      // - base speed slowed by 1/2
      // - every 2% deeper into the edge zone adds +25% acceleration
      const BASE_SCROLL_SPEED = 0.175;
      const accelerationSteps = Math.floor(proximityRatio / 0.10);
      const accelerationMultiplier = 1 + accelerationSteps * 0.25;

      const current = scroller.scrollLeft;
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const directionalDistance = Math.sign(edgeDelta) * clampedDistanceIntoZone;
      const next = Math.max(
        0,
        Math.min(
          maxScroll,
          current + directionalDistance * BASE_SCROLL_SPEED * accelerationMultiplier
        )
      );
      if (Math.abs(next - current) < 0.5) return;

      scroller.scrollLeft = next;
      setScrollX(next);
    },
    [setScrollX]
  );

  const timelineDuration = projectDuration || duration || 0;
  const totalWidth = Math.max(containerWidth, timelineDuration > 0 ? timelineDuration * pixelsPerSecond : containerWidth);

  return (
    <div
      className="bg-surface-dark border-b border-panel-border flex flex-col h-full min-h-0"
      tabIndex={0}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
          return;
        }

        if (event.key === "Delete") {
          event.preventDefault();
          void handleDeleteSelected();
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          handleUndoSegmentDelete();
        }
      }}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageOverlaySelected}
      />
      {(playerFilterOpen || statsFilterOpen) && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => { setPlayerFilterOpen(false); setStatsFilterOpen(false); }}
        />
      )}
      <div className="flex flex-wrap items-center gap-3 border-b border-panel-border px-4 py-2 text-xs text-gray-300">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-panel-border bg-panel/70 px-2 py-1">
            <div className="flex items-center gap-2">
              <button
                onClick={handleAddTextOverlay}
                disabled={!videoSrc}
                className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Add text overlay"
              >
                <span className="flex items-center gap-1">
                  ✎ <span className="text-xs uppercase">Text</span>
                </span>
              </button>
              <button
                onClick={handleTriggerImageOverlay}
                disabled={!videoSrc}
                className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Insert image overlay"
              >
                <span className="flex items-center gap-1">
                  🖼 <span className="text-xs uppercase">Image</span>
                </span>
              </button>
            </div>
            <div className="h-6 w-px bg-panel-border/60" aria-hidden="true" />
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-gray-500">
              <span className="text-[9px] tracking-[0.3em]">Z-Order</span>
              <button
                onPointerDown={handleZOrderPointerDown}
                onClick={handleSendBackwardClick}
                disabled={!hasOverlaySelection}
                className="px-2 py-1 rounded bg-panel-border/30 text-gray-300 hover:bg-panel-border/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Back
              </button>
              <button
                onPointerDown={handleZOrderPointerDown}
                onClick={handleBringForwardClick}
                disabled={!hasOverlaySelection}
                className="px-2 py-1 rounded bg-panel-border/30 text-gray-300 hover:bg-panel-border/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Front
              </button>
            </div>
          </div>
          <button onClick={handleAddMarker} className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors">
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="#ff3b3b" d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z"/>
              </svg>
              <span className="text-xs uppercase">Marker</span>
            </span>
          </button>
          <button
            onClick={toggleKeyframeMode}
            className={`px-2 py-1 rounded transition-colors ${
              keyframeMode ? "bg-accent text-white" : "bg-panel hover:bg-panel-border"
            }`}
          >
            🔑 Keyframe
          </button>
          <button
            onClick={handleCenterOnPlayhead}
            className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors"
          >
            🎯 Center
          </button>
          <button
            onClick={handleAddHighlight}
            className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors"
          >
            ➕ Highlight
          </button>
          <button
            onClick={handleRemoveHighlight}
            className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors"
          >
            ➖ Highlight
          </button>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedMarkerIds.length === 0 && overlaySelection.length === 0 && !selectedSegmentId}
            className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            🗑 Delete
          </button>
          <button
            onClick={handleUndoSegmentDelete}
            className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors"
            title="Undo last segment delete"
          >
            ↩ Undo
          </button>
          <div className="flex items-center gap-2 rounded-lg border border-panel-border bg-panel/70 px-2 py-1">
            <span className="text-gray-500 text-[10px] uppercase tracking-[0.2em]">Video Zoom</span>
            <input
              type="range"
              min={100}
              max={300}
              value={zoomPercent}
              onChange={(e) => setZoomPercent(Number(e.target.value))}
            />
            <span className="w-12 text-right">{zoomPercent}%</span>
            <div className="h-6 w-px bg-panel-border/60" aria-hidden="true" />
            <button onClick={zoomOut} className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors">
              −
            </button>
            <span className="w-16 text-center text-gray-500">{pixelsPerSecond.toFixed(0)} px/s</span>
            <button onClick={zoomIn} className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors">
              +
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {hasActiveFilter && filteredRecentPlays.length > 0 && (
            <button
              type="button"
              onClick={handlePreviewStats}
              className="px-2 py-1 rounded text-[11px] transition-colors border bg-panel border-panel-border hover:bg-panel-border text-gray-300 hover:text-accent"
              title="Preview Stats"
            >
              {previewClipRef.current ? "⏹" : "▶"}
            </button>
          )}
          {/* Player filter */}
          <div className="relative">
            <button
              onClick={() => { setPlayerFilterOpen((p) => !p); setStatsFilterOpen(false); }}
              className={`px-2 py-1 rounded text-[11px] transition-colors border ${filterPlayers.length > 0 ? "bg-accent/20 border-accent/50 text-accent" : "bg-panel border-panel-border hover:bg-panel-border text-gray-300"}`}
            >
              Player {filterPlayers.length > 0 ? `(${filterPlayers.length})` : "▾"}
            </button>
            {playerFilterOpen && uniquePlayerNames.length > 0 && (
              <div className="absolute right-0 top-full mt-1 bg-surface border border-panel-border rounded shadow-xl z-50 min-w-[140px] max-h-48 overflow-y-auto">
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-gray-400 hover:bg-panel-border/40 border-b border-panel-border/40"
                  onClick={() => setFilterPlayers([])}
                >
                  Clear filter
                </button>
                {uniquePlayerNames.map((name) => (
                  <label key={name} className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-gray-200 hover:bg-panel-border/40 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filterPlayers.includes(name)}
                      onChange={() =>
                        setFilterPlayers((prev) =>
                          prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
                        )
                      }
                      className="accent-accent"
                    />
                    {name}
                  </label>
                ))}
              </div>
            )}
          </div>
          {/* Stats filter */}
          <div className="relative">
            <button
              onClick={() => { setStatsFilterOpen((p) => !p); setPlayerFilterOpen(false); }}
              className={`px-2 py-1 rounded text-[11px] transition-colors border ${filterStats.length > 0 ? "bg-accent/20 border-accent/50 text-accent" : "bg-panel border-panel-border hover:bg-panel-border text-gray-300"}`}
            >
              Stats {filterStats.length > 0 ? `(${filterStats.length})` : "▾"}
            </button>
            {statsFilterOpen && uniqueStatTypes.length > 0 && (
              <div className="absolute right-0 top-full mt-1 bg-surface border border-panel-border rounded shadow-xl z-50 min-w-[140px] max-h-48 overflow-y-auto">
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-gray-400 hover:bg-panel-border/40 border-b border-panel-border/40"
                  onClick={() => setFilterStats([])}
                >
                  Clear filter
                </button>
                {uniqueStatTypes.map((type) => (
                  <label key={type} className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-gray-200 hover:bg-panel-border/40 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filterStats.includes(type)}
                      onChange={() =>
                        setFilterStats((prev) =>
                          prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
                        )
                      }
                      className="accent-accent"
                    />
                    {formatMarkerLabel(type)}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden bg-[#050509]">
          <div
            ref={scrollRef}
            className="h-full min-h-0 overflow-auto"
            onWheel={handleWheel}
            onScroll={handleScroll}
          >
            <TimelineRenderer
              totalWidth={totalWidth}
              pixelsPerSecond={pixelsPerSecond}
              projectPlayhead={projectPlayhead}
              projectDuration={projectDuration}
              duration={duration}
              markers={filteredMarkers}
              thumbnails={thumbnails}
              assetsLoading={assetsLoading}
              thumbnailsGenerating={thumbnailsGenerating}
              onSeek={handleSeek}
              onMarkerClick={handleMarkerClick}
              selectedIds={selectedMarkerIds}
              onSelectMarker={handleSelectMarker}
              onBackgroundClick={clearSelection}
              onResizeHandleDown={handleResizeStart}
              onResizeDrag={handleResizeDrag}
              onResizeEnd={handleResizeEnd}
              onCut={handleAddCutPoint}
              onDeleteSegment={handleDeleteSegment}
              segments={segments}
              canDeleteSegments={segments.length > 1}
              onRenameMarker={handleRenameMarker}
              selectedSegmentId={selectedSegmentId}
              onSegmentSelect={setSelectedSegmentId}
              onPlayheadDragStart={handlePlayheadDragStart}
              onPlayheadDragMove={handlePlayheadDragMove}
              onPlayheadDragEnd={handlePlayheadDragEnd}
            />
          </div>
        </div>
        <aside className="relative z-20 w-72 min-w-72 border-l border-panel-border bg-surface px-4 py-4 flex flex-col gap-3 min-h-0">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-gray-500">
            <span>Recent Plays</span>
            <span className="text-[10px] text-gray-600">{filteredRecentPlays.length}{hasActiveFilter ? ` / ${recentTimelinePlays.length}` : ""}</span>
          </div>
          <div
            ref={recentListRef}
            className="flex-1 min-h-0 overflow-y-auto pr-1"
            onScroll={(event) => setRecentPlaysScrollTop(event.currentTarget.scrollTop)}
          >
            {filteredRecentPlays.length === 0 && (
              <span className="text-gray-600 text-xs">{recentTimelinePlays.length === 0 ? "Tag a stat to see it here." : "No plays match the filter."}</span>
            )}
            <div style={{ height: `${filteredRecentPlays.length * recentRowHeight}px`, position: "relative" }}>
              {visibleRecentTimelinePlays.map((marker, idx) => {
                const style = getRecentPlayStyle(marker.event_type);
                const isEditing = editingMarkerId === marker.id;
                const markerTop = (recentStartIndex + idx) * recentRowHeight;
                const openDown = markerTop < recentViewportSafeHeight / 2;

                return (
                  <div
                    key={`recent-timeline-${marker.id}`}
                    className="absolute left-0 right-0"
                    style={{
                      top: `${markerTop}px`,
                      height: `${recentRowHeight - 6}px`,
                    }}
                  >
                    <button
                      className={`group w-full h-full flex items-center justify-between rounded-lg border bg-white/5 px-3 py-2 text-[11px] text-gray-200 transition hover:bg-white/10 ${style.borderClass}`}
                      onClick={() => {
                        if (isEditing) { setEditingMarkerId(null); setEditMode(null); return; }
                        handleRecentPlayClick(marker);
                      }}
                      onDoubleClick={() => handleRecentPlayClick(marker)}
                    >
                      <div className="flex flex-col text-left">
                        <span className={`text-[10px] uppercase tracking-wide ${style.statTextClass}`}>{formatMarkerLabel(marker.event_type)}</span>
                        <strong className="text-white text-xs">{marker.player_name ?? marker.label ?? "Play"}</strong>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-gray-400">{formatClock(marker.time)}</span>
                        <span
                          className={`text-[13px] transition-colors ${isEditing ? "opacity-100 text-accent" : "opacity-0 group-hover:opacity-100 text-gray-500 hover:text-accent"}`}
                          title="Edit play"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (isEditing) { setEditingMarkerId(null); setEditMode(null); }
                            else { setEditingMarkerId(marker.id); setEditMode("menu"); }
                          }}
                        >
                          ✎
                        </span>
                        <span
                          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400"
                          onClick={(event) => {
                            event.stopPropagation();
                            void PlayCoordinator.removePlays([marker.id]);
                          }}
                        >
                          🗑
                        </span>
                      </div>
                    </button>
                    {isEditing && (
                      <div
                        className="absolute right-0 z-[120] bg-panel border border-panel-border rounded-lg shadow-xl p-2 min-w-[220px] max-w-[280px] max-h-[220px] overflow-y-auto"
                        style={openDown ? { top: "calc(100% + 4px)" } : { bottom: "calc(100% + 4px)" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {editMode === "menu" && (
                          <div className="flex items-center gap-1 text-xs text-gray-300">
                            <span className="text-gray-400">Change</span>
                            <button
                              className="text-center text-xs px-2 py-1 rounded hover:bg-panel-border text-gray-200 transition-colors"
                              onClick={() => setEditMode("type")}
                            >
                              Play
                            </button>
                            <span className="text-gray-500">|</span>
                            <button
                              className="text-center text-xs px-2 py-1 rounded hover:bg-panel-border text-gray-200 transition-colors"
                              onClick={() => setEditMode("player")}
                            >
                              Player
                            </button>
                          </div>
                        )}
                        {editMode === "type" && (
                          <div className="flex flex-col gap-1">
                            <div className="text-[10px] uppercase tracking-wider text-gray-500 px-1 pb-1">Select type</div>
                            <div className="grid grid-cols-2 gap-1">
                              {ALL_STAT_TYPES.map((t) => (
                                <button
                                  key={t}
                                  className={`text-center text-[11px] px-2 py-1 rounded transition-colors ${t === marker.event_type ? "bg-accent/20 text-accent" : "hover:bg-panel-border text-gray-300"}`}
                                  onClick={async () => {
                                    await DatabaseService.updatePlayEventAndPlayer(marker.id, t, null);
                                    await PlayCoordinator.refreshPlaysFromDatabase();
                                    setEditingMarkerId(null);
                                    setEditMode(null);
                                  }}
                                >
                                  {formatMarkerLabel(t)}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {editMode === "player" && (
                          <div className="flex flex-col gap-1">
                            <div className="text-[10px] uppercase tracking-wider text-gray-500 px-1 pb-1">Select player</div>
                            <div className="grid grid-cols-2 gap-1">
                              {players.map((p) => (
                                <button
                                  key={p.id}
                                  className={`text-left text-[11px] px-2 py-1 rounded transition-colors truncate ${p.name === marker.player_name ? "bg-accent/20 text-accent" : "hover:bg-panel-border text-gray-300"}`}
                                  onClick={async () => {
                                    await DatabaseService.updatePlayEventAndPlayer(marker.id, null, p.id);
                                    await PlayCoordinator.refreshPlaysFromDatabase();
                                    setEditingMarkerId(null);
                                    setEditMode(null);
                                  }}
                                >
                                  #{p.number} {p.name}
                                </button>
                              ))}
                            </div>
                            <div className="border-t border-panel-border mt-1 pt-1">
                              <button
                                className="w-full text-center text-[11px] px-2 py-1 rounded transition-colors hover:bg-red-900/40 text-red-400"
                                onClick={async () => {
                                  await ProjectService.ensureProjectDbOpen();
                                  const timestamp = marker.time;
                                  const eventType = marker.event_type;
                                  // Remove the home play (updates score, markers, db)
                                  await PlayCoordinator.removePlays([marker.id]);
                                  // Record as opponent stat
                                  const result = await DatabaseService.addOpponentStat(timestamp, eventType);
                                  addOpponentPlay({ id: result.id, timestamp: result.timestamp, event_type: result.event_type });
                                  setEditingMarkerId(null);
                                  setEditMode(null);
                                }}
                              >
                                Opponent
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
