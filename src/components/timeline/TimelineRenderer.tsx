import {
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { TimelineMarker } from "../../store/types";
import { TimelineThumbnail, TimelineSegment } from "../../store/timelineStore";

const STAT_COLORS: Record<string, string> = {
  "2PT": "#22c55e",
  "2PT_MISS": "#15803d",
  "3PT": "#16a34a",
  "3PT_MISS": "#166534",
  FT: "#15803d",
  "FT_MISS": "#0f172a",
  AST: "#3b82f6",
  REB: "#eab308",
  STL: "#a855f7",
  BLK: "#ef4444",
  TO: "#f97316",
  FOUL: "#e11d48",
  MARKER: "#9ca3af",
  HIGHLIGHT: "#fbbf24",
};

const MAX_TAG_ROWS = 3;
const TAG_ROW_HEIGHT = 20;
const TAG_ROW_GAP = 6;

interface MarkerBlockLayout {
  marker: TimelineMarker;
  projectStart: number;
  projectEnd: number;
  width: number;
  selected: boolean;
  missTag: boolean;
  color: string;
  label: string;
  lineX: number;
  row: number;
}

interface Props {
  totalWidth: number;
  pixelsPerSecond: number;
  projectPlayhead: number;
  projectDuration: number;
  duration: number;
  segments: TimelineSegment[];
  markers: TimelineMarker[];
  thumbnails: TimelineThumbnail[];
  assetsLoading: boolean;
  thumbnailsGenerating: boolean;
  onSeek: (projectTime: number) => void;
  onMarkerClick: (marker: TimelineMarker) => void;
  selectedIds: number[];
  onSelectMarker: (markerId: number, additive: boolean) => void;
  onBackgroundClick: () => void;
  onResizeHandleDown: (markerId: number, edge: "start" | "end") => void;
  onResizeDrag: (time: number) => void;
  onResizeEnd: () => void;
  onCut: () => void;
  onDeleteSegment: (segmentId: string) => void;
  canDeleteSegments: boolean;
  onRenameMarker: (marker: TimelineMarker) => void;
  selectedSegmentId: string | null;
  onSegmentSelect: (segmentId: string | null) => void;
  onPlayheadDragStart: () => void;
  onPlayheadDragMove: (clientX: number) => void;
  onPlayheadDragEnd: () => void;
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  const hundredths = Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${secs}.${hundredths}`;
};

const hexToRgba = (hex: string, alpha: number) => {
  const sanitized = hex.replace("#", "");
  const bigint = parseInt(sanitized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const formatEventLabel = (eventType: string) => {
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

const isMissEvent = (eventType: string) =>
  eventType === "2PT_MISS" || eventType === "3PT_MISS" || eventType === "FT_MISS";

export function TimelineRenderer({
  totalWidth,
  pixelsPerSecond,
  projectPlayhead,
  projectDuration,
  duration,
  segments,
  markers,
  thumbnails,
  assetsLoading,
  thumbnailsGenerating,
  onSeek,
  onMarkerClick,
  selectedIds,
  onSelectMarker,
  onBackgroundClick,
  onResizeHandleDown,
  onResizeDrag,
  onResizeEnd,
  onCut,
  onDeleteSegment,
  canDeleteSegments,
  onRenameMarker,
  selectedSegmentId,
  onSegmentSelect,
  onPlayheadDragStart,
  onPlayheadDragMove,
  onPlayheadDragEnd,
}: Props) {
  const scrubRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const resizingRef = useRef<{ markerId: number; edge: "start" | "end" } | null>(null);

  const trackDuration = projectDuration || duration;

  const isTimeWithinSegments = useCallback(
    (time: number) => {
      if (!segments.length || duration <= 0) {
        return duration <= 0 ? true : time >= 0 && time <= duration;
      }
      return segments.some((segment) => time >= segment.start && time <= segment.end);
    },
    [segments, duration]
  );

  const sourceToProject = useCallback(
    (sourceTime: number) => {
      if (!segments.length || trackDuration <= 0) {
        return Math.max(0, Math.min(sourceTime, trackDuration));
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
    [segments, trackDuration]
  );

  const projectToSource = useCallback(
    (projectTime: number) => {
      if (!segments.length || trackDuration <= 0) {
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
      return last ? last.end : projectTime;
    },
    [segments, trackDuration, duration]
  );

  const ticks = useMemo(() => {
    if (trackDuration <= 0) return [];
    let interval = 60;
    if (pixelsPerSecond >= 200) interval = 0.5;
    else if (pixelsPerSecond >= 120) interval = 1;
    else if (pixelsPerSecond >= 60) interval = 2;
    else if (pixelsPerSecond >= 30) interval = 5;
    else if (pixelsPerSecond >= 15) interval = 10;
    else if (pixelsPerSecond >= 8) interval = 15;
    else if (pixelsPerSecond >= 4) interval = 30;
    const frames = [];
    for (let t = 0; t <= trackDuration; t += interval) {
      frames.push({ time: t, x: t * pixelsPerSecond });
    }
    return frames;
  }, [trackDuration, pixelsPerSecond]);

  const getTimeFromPointer = useCallback((clientX: number) => {
    const rect = scrubRef.current?.getBoundingClientRect();
    if (!rect || pixelsPerSecond === 0) return 0;
    const x = clientX - rect.left;
    const unclamped = x / pixelsPerSecond;
    const maxTime = Math.max(0, trackDuration);
    return Math.max(0, Math.min(maxTime, unclamped));
  }, [trackDuration, pixelsPerSecond]);

  const handleTrackPointerDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (
        target.closest("[data-marker-block]") ||
        target.closest("[data-marker-pin]") ||
        target.dataset.handle
      ) {
        return;
      }
      const time = getTimeFromPointer(event.clientX);
      onBackgroundClick();
      onSeek(time);
    },
    [getTimeFromPointer, onBackgroundClick, onSeek]
  );

  const handleTrackDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.closest("[data-marker-block]") ||
        target.closest("[data-marker-pin]") ||
        target.dataset.handle
      ) {
        return;
      }
      const projectTime = getTimeFromPointer(event.clientX);
      const sourceTime = projectToSource(projectTime);
      const hitSegment = segments.find(
        (segment) => sourceTime >= segment.start && sourceTime <= segment.end
      );
      if (!hitSegment) {
        return;
      }
      const projectStart = sourceToProject(hitSegment.start);
      onSeek(projectStart);
    },
    [getTimeFromPointer, projectToSource, segments, sourceToProject, onSeek]
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (draggingRef.current) {
        const time = getTimeFromPointer(event.clientX);
        onPlayheadDragMove(event.clientX);
        onSeek(time);
      }
      if (resizingRef.current) {
        const projectTime = getTimeFromPointer(event.clientX);
        onResizeDrag(projectToSource(projectTime));
      }
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        onPlayheadDragEnd();
      }
      if (resizingRef.current) {
        resizingRef.current = null;
        onResizeEnd();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [getTimeFromPointer, onPlayheadDragEnd, onPlayheadDragMove, onSeek, onResizeDrag, onResizeEnd, projectToSource]);

  const playheadX = Math.max(0, Math.min(totalWidth, projectPlayhead * pixelsPerSecond));

  const markerCards = markers.reduce<JSX.Element[]>((acc, marker) => {
    if (!isTimeWithinSegments(marker.time)) {
      return acc;
    }
    const projectTime = sourceToProject(marker.time);
    const safeX = Math.max(0, Math.min(totalWidth, projectTime * pixelsPerSecond));
    const color = STAT_COLORS[marker.event_type] || "#38bdf8";
    const missTag = isMissEvent(marker.event_type);
    const friendlyEvent = formatEventLabel(marker.event_type);
    const label = marker.event_type === "MARKER"
      ? marker.label ?? "Marker"
      : marker.player_name
        ? `${marker.player_name} • ${friendlyEvent}`
        : friendlyEvent;
    const selected = selectedIds.includes(marker.id);
    acc.push(
      <button
        key={marker.id}
        className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-wide shadow-lg shadow-black/40 ${
          missTag
            ? "border-gray-200/70 bg-transparent text-gray-300"
            : "border-white/10 bg-[#050512] text-gray-200"
        }`}
        style={{ left: safeX, top: "50%", zIndex: selected ? 30 : 10 }}
        data-marker-pin
        onClick={(event) => {
          onSelectMarker(marker.id, event.metaKey || event.ctrlKey || event.shiftKey);
          onMarkerClick(marker);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={() => {
          if (marker.event_type === "MARKER") {
            onRenameMarker(marker);
          } else {
            onMarkerClick(marker);
          }
        }}
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: missTag ? "#d1d5db" : color }}
        />
        {label}
        <span className={`${missTag ? "text-gray-300/80" : `text-gray-500 ${selected ? "text-white" : ""}`}`}>
          {formatTime(marker.time)}
        </span>
      </button>
    );
    return acc;
  }, []);

  type BlockCandidate = Omit<MarkerBlockLayout, "row">;

  const blockCandidates = markers
    .map<BlockCandidate | null>((marker) => {
      const color = STAT_COLORS[marker.event_type] || "#38bdf8";
      const startTime = Math.min(marker.start_time, marker.end_time);
      const endTime = Math.max(marker.start_time, marker.end_time);
      if (!isTimeWithinSegments(startTime) || !isTimeWithinSegments(endTime)) {
        return null;
      }
      const projectStart = sourceToProject(startTime);
      const projectEnd = sourceToProject(endTime);
      const width = Math.max(2, (projectEnd - projectStart) * pixelsPerSecond);
      const selected = selectedIds.includes(marker.id);
      const missTag = isMissEvent(marker.event_type);
      const friendlyEvent = formatEventLabel(marker.event_type);
      const label = marker.event_type === "MARKER"
        ? marker.label ?? "Marker"
        : marker.player_name
          ? `${marker.player_name} • ${friendlyEvent}`
          : friendlyEvent;
      const eventProject = sourceToProject(marker.time);
      const eventOffsetPx = (eventProject - projectStart) * pixelsPerSecond;
      const lineX = Math.min(Math.max(eventOffsetPx, 0), width);
      return {
        marker,
        projectStart,
        projectEnd,
        width,
        selected,
        missTag,
        color,
        label,
        lineX,
      };
    })
    .filter((entry): entry is BlockCandidate => Boolean(entry))
    .sort((a, b) => a.projectStart - b.projectStart);

  const markerBlockLayouts: MarkerBlockLayout[] = [];
  const rowUsage = Array(MAX_TAG_ROWS).fill(-Infinity);

  blockCandidates.forEach((entry) => {
    const overlaps = rowUsage.map((end) => Math.max(0, end - entry.projectStart));
    let rowIndex = overlaps.findIndex((overlap) => overlap <= 0);
    if (rowIndex === -1) {
      let minOverlap = overlaps[0];
      rowIndex = 0;
      for (let i = 1; i < overlaps.length; i += 1) {
        if (overlaps[i] < minOverlap) {
          minOverlap = overlaps[i];
          rowIndex = i;
        }
      }
    }
    rowUsage[rowIndex] = Math.max(entry.projectEnd, rowUsage[rowIndex]);
    markerBlockLayouts.push({ ...entry, row: rowIndex });
  });

  const markerBlocks = markerBlockLayouts.map((entry) => (
    <div
      key={`block-${entry.marker.id}`}
      data-marker-block
      className={`group absolute flex items-center gap-2 rounded-md border-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/80 shadow-[inset_0_0_6px_rgba(0,0,0,0.25)] ${
        entry.selected ? "ring-2 ring-yellow-200/70" : ""
      }`}
      style={{
        left: entry.projectStart * pixelsPerSecond,
        width: entry.width,
        top: entry.row * (TAG_ROW_HEIGHT + TAG_ROW_GAP),
        height: TAG_ROW_HEIGHT,
        borderColor: entry.missTag ? "rgba(229, 231, 235, 0.85)" : entry.color,
        backgroundColor: entry.missTag
          ? "rgba(0, 0, 0, 0)"
          : hexToRgba(entry.color, entry.selected ? 0.95 : 0.8),
        zIndex: entry.selected ? 25 : 5,
      }}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement)?.dataset.handle) return;
        onSelectMarker(entry.marker.id, event.metaKey || event.ctrlKey || event.shiftKey);
      }}
      onDoubleClick={() => onMarkerClick(entry.marker)}
    >
      <span className={`pointer-events-none flex-1 truncate text-[9px] ${entry.missTag ? "text-gray-200/80" : "text-black/70"}`}>
        {entry.label}
      </span>
      <span className={`pointer-events-none ml-auto text-[9px] ${entry.missTag ? "text-gray-300/80" : "text-black/60"}`}>
        {formatTime(entry.marker.time)}
      </span>
      {entry.selected && (
        <>
          <button
            className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/20"
            data-handle="start"
            onMouseDown={(event) => {
              event.stopPropagation();
              resizingRef.current = { markerId: entry.marker.id, edge: "start" };
              onResizeHandleDown(entry.marker.id, "start");
            }}
          />
          <button
            className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/20"
            data-handle="end"
            onMouseDown={(event) => {
              event.stopPropagation();
              resizingRef.current = { markerId: entry.marker.id, edge: "end" };
              onResizeHandleDown(entry.marker.id, "end");
            }}
          />
        </>
      )}
      <div
        className={`pointer-events-none absolute w-px rounded ${entry.missTag ? "bg-gray-200/70" : "bg-black/70"}`}
        style={{ left: entry.lineX, top: 3, bottom: 3 }}
      />
    </div>
  ));

  let rollingProject = 0;
  const segmentBoxes = segments.reduce<JSX.Element[]>((acc, segment) => {
    const segDuration = Math.max(0, segment.end - segment.start);
    if (segDuration <= 0) {
      return acc;
    }
    const left = rollingProject * pixelsPerSecond;
    const width = Math.max(40, segDuration * pixelsPerSecond);
    const startLabel = formatTime(segment.start);
    const endLabel = formatTime(segment.end);
    const label = `Segment ${acc.length + 1}`;
    const isSelected = selectedSegmentId === segment.id;
    const borderClass = isSelected ? "border-[#05C607] ring-2 ring-[#05C607]/70" : "border-white/30";
    const backgroundClass = isSelected ? "bg-[#102815]/60" : "bg-black/30";
    acc.push(
      <div
        key={segment.id}
        className={`pointer-events-none absolute top-1 bottom-1 rounded-xl border ${borderClass} ${backgroundClass} px-3 py-1 text-[10px] text-white/90 shadow-inner shadow-black/40`}
        style={{ left, width }}
      >
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide">
          <span>{label}</span>
          {canDeleteSegments && (
            <button
              type="button"
              className="pointer-events-auto ml-2 text-xs text-gray-400 transition hover:text-white"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteSegment(segment.id);
              }}
              title="Delete segment"
            >
              ×
            </button>
          )}
        </div>
        <div className="text-[9px] text-gray-400">{startLabel} → {endLabel}</div>
      </div>
    );
    rollingProject += segDuration;
    return acc;
  }, []);

  const cutLines: number[] = [];
  if (segments.length > 1) {
    let boundary = 0;
    segments.forEach((segment, index) => {
      const segDuration = Math.max(0, segment.end - segment.start);
      boundary += segDuration;
      if (index < segments.length - 1) {
        cutLines.push(boundary);
      }
    });
  }

  const tagAreaHeight = MAX_TAG_ROWS * TAG_ROW_HEIGHT + (MAX_TAG_ROWS - 1) * TAG_ROW_GAP + 12;
  const markerBubbleHeight = 44;

  const renderThumbnails = () => {
    const usableThumbs = thumbnails
      .filter((thumb) => isTimeWithinSegments(thumb.time))
      .map((thumb) => ({
        ...thumb,
        projectTime: sourceToProject(thumb.time),
      }))
      .sort((a, b) => a.projectTime - b.projectTime);

    if (usableThumbs.length === 0) {
      return (
        <div className="flex h-full w-full items-center justify-center text-xs text-gray-600">
          {thumbnailsGenerating
            ? "Generating preview frames…"
            : duration > 0
              ? "Preview frames loading…"
              : "Load a clip to see preview thumbnails"}
        </div>
      );
    }

    return usableThumbs.map((thumb, index) => {
      const nextProject = usableThumbs[index + 1]?.projectTime ?? trackDuration;
      const width = Math.max(40, (nextProject - thumb.projectTime) * pixelsPerSecond);
      return (
        <div
          key={thumb.time}
          className="h-10 flex-shrink-0 overflow-hidden border-r border-white/5"
          style={{ width }}
        >
          <img src={thumb.src} alt="Timeline thumbnail" className="h-full w-full object-cover" />
        </div>
      );
    });
  };

  return (
    <div className="relative" style={{ width: totalWidth }}>
      <div
        ref={scrubRef}
        className="relative rounded-2xl border border-white/5 bg-gradient-to-b from-[#0f0f1f] to-[#04040c] p-3 shadow-inner shadow-black/40"
        onMouseDown={handleTrackPointerDown}
        onDoubleClick={handleTrackDoubleClick}
      >
        <div className="relative mb-2 h-8 rounded-md bg-black/10">
          {ticks.map((tick) => {
            const left = tick.time * pixelsPerSecond;
            return (
              <div
                key={`tick-${tick.time}`}
                className="absolute inset-y-0 w-px bg-white/10"
                style={{ left }}
              >
                <span className="absolute -top-4 -left-6 w-12 text-center text-[10px] text-gray-500">
                  {formatTime(tick.time)}
                </span>
              </div>
            );
          })}
        </div>
        <div
          className="relative flex h-10 overflow-hidden rounded-lg border border-white/5 bg-black/30 transition-shadow"
          data-video-track
          onMouseDown={(event) => {
            event.stopPropagation();
            const projectTime = getTimeFromPointer(event.clientX);
            const sourceTime = projectToSource(projectTime);
            const hitSegment = segments.find(
              (segment) => sourceTime >= segment.start && sourceTime <= segment.end
            );
            onSegmentSelect(hitSegment ? hitSegment.id : null);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {renderThumbnails()}
          <div className="absolute inset-0 pointer-events-none">
            {segmentBoxes}
          </div>
        </div>
        <div
          className="relative mt-3 rounded-md bg-black/25"
          style={{ height: tagAreaHeight }}
        >
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/5" />
          {markerBlocks}
          {cutLines.map((cut) => {
            const x = cut * pixelsPerSecond;
            return (
              <div
                key={`cut-${cut}`}
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/20"
                style={{ left: x }}
              />
            );
          })}
        </div>
        <div
          className="relative mt-2 rounded-md bg-black/15"
          style={{ height: markerBubbleHeight }}
        >
          {markerCards}
        </div>
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div
            className="absolute top-0 bottom-0 w-px rounded bg-[#fcd34d]"
            style={{ left: playheadX }}
          />
        </div>
        <div className="pointer-events-none absolute left-0 right-0 top-1">
          <div
            className="flex flex-col items-center text-[11px] text-white"
            style={{ left: playheadX, position: "absolute", transform: "translateX(-50%)" }}
          >
            <button
              type="button"
              onMouseDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                draggingRef.current = true;
                onPlayheadDragStart();
                const time = getTimeFromPointer(event.clientX);
                onPlayheadDragMove(event.clientX);
                onSeek(time);
              }}
              onClick={(event) => event.stopPropagation()}
              className="pointer-events-auto rounded-full bg-[#fcd34d] px-2 py-0.5 text-[10px] uppercase tracking-wide text-black shadow"
            >
              {formatTime(projectPlayhead)}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCut();
              }}
              className="pointer-events-auto mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-[#1f2937] text-xs shadow-lg shadow-black/40"
              title="Split at playhead"
            >
              ✂
            </button>
          </div>
        </div>
        {thumbnailsGenerating && thumbnails.length === 0 && (
          <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-gray-400 shadow-lg">
            <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            Generating preview frames…
          </div>
        )}
      </div>
    </div>
  );
}
