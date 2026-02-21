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

export function TimelinePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const lastVideoPathRef = useRef<string | null>(null);

  const pixelsPerSecond = useTimelineStore((s) => s.pixelsPerSecond);
  const setPixelsPerSecond = useTimelineStore((s) => s.setPixelsPerSecond);
  const scrollX = useTimelineStore((s) => s.scrollX);
  const setScrollX = useTimelineStore((s) => s.setScrollX);
  const playheadTime = useTimelineStore((s) => s.playheadTime);
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime);
  const thumbnails = useTimelineStore((s) => s.thumbnails);
  const assetsLoading = useTimelineStore((s) => s.assetsLoading);
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
  const selectedSegmentId = useTimelineStore((s) => s.selectedSegmentId);
  const setSelectedSegmentId = useTimelineStore((s) => s.setSelectedSegmentId);
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
    if (!videoPath || duration <= 0) {
      if (!videoPath) {
        lastVideoPathRef.current = null;
        initializeSegments(0);
      }
      return;
    }
    if (!segments.length || lastVideoPathRef.current !== videoPath) {
      initializeSegments(duration);
      lastVideoPathRef.current = videoPath;
      setCurrentTime(0);
      setPlayheadTime(0);
      videoEngine.seek(0);
    }
  }, [duration, videoPath, segments.length, initializeSegments, setCurrentTime, setPlayheadTime]);

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
    .sort((a, b) => b.time - a.time)
    .slice(0, 8);

  const handleDeleteSelected = async () => {
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
  };

  const handleDeleteSegment = (segmentId: string) => {
    if (segments.length <= 1) return;
    removeSegment(segmentId);
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
    const target = Math.max(0, playheadTime * pixelsPerSecond - containerWidth / 2);
    scrollRef.current.scrollTo({ left: target, behavior: "smooth" });
    setScrollX(target);
  };

  useEffect(() => {
    if (!scrollRef.current) return;
    const target = Math.max(0, projectPlayhead * pixelsPerSecond - containerWidth / 2);
    if (Math.abs(target - scrollX) < 1) return;
    scrollRef.current.scrollTo({ left: target, behavior: "smooth" });
    setScrollX(target);
  }, [projectPlayhead, pixelsPerSecond, containerWidth, scrollX, setScrollX]);

  const timelineDuration = projectDuration || duration || 0;
  const totalWidth = Math.max(containerWidth, timelineDuration > 0 ? timelineDuration * pixelsPerSecond : containerWidth);

  return (
    <div
      className="bg-surface-dark border-b border-panel-border flex flex-col shrink-0"
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageOverlaySelected}
      />
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
            ✂ Marker
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
            disabled={selectedMarkerIds.length === 0 && overlaySelection.length === 0}
            className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            🗑 Delete
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 ml-auto">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Video Zoom</span>
            <input
              type="range"
              min={0}
              max={300}
              value={zoomPercent}
              onChange={(e) => setZoomPercent(Number(e.target.value))}
            />
            <span className="w-12 text-right">{zoomPercent}%</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button onClick={zoomOut} className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors">
              −
            </button>
            <span className="w-16 text-center text-gray-500">{pixelsPerSecond.toFixed(0)} px/s</span>
            <button onClick={zoomIn} className="px-2 py-1 bg-panel rounded hover:bg-panel-border transition-colors">
              +
            </button>
          </div>
        </div>
      </div>
      <div className="flex">
        <div ref={containerRef} className="flex-1 overflow-hidden bg-[#050509]">
          <div
            ref={scrollRef}
            className="h-[260px] overflow-auto"
            onWheel={handleWheel}
            onScroll={handleScroll}
          >
            <TimelineRenderer
              totalWidth={totalWidth}
              pixelsPerSecond={pixelsPerSecond}
              projectPlayhead={projectPlayhead}
              projectDuration={projectDuration}
              duration={duration}
              markers={markers}
              thumbnails={thumbnails}
              assetsLoading={assetsLoading}
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
            />
          </div>
        </div>
        <aside className="w-72 h-[260px] border-l border-panel-border bg-surface px-4 py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-gray-500">
            <span>Recent Plays</span>
            <span className="text-[10px] text-gray-600">{recentTimelinePlays.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-2">
            {recentTimelinePlays.length === 0 && (
              <span className="text-gray-600 text-xs">Tag a stat to see it here.</span>
            )}
            {recentTimelinePlays.map((marker) => (
              <button
                key={`recent-timeline-${marker.id}`}
                className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-gray-200 transition hover:bg-white/10"
                onClick={() => {
                  handleSelectMarker(marker.id, false);
                  handleMarkerClick(marker);
                }}
                onDoubleClick={() => handleMarkerClick(marker)}
              >
                <div className="flex flex-col text-left">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">{formatMarkerLabel(marker.event_type)}</span>
                  <strong className="text-white text-xs">{marker.player_name ?? marker.label ?? "Play"}</strong>
                </div>
                <span className="font-mono text-[11px] text-gray-400">{formatClock(marker.time)}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
