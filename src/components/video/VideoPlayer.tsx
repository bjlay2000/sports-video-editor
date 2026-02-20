import {
  useRef,
  useEffect,
  useCallback,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { videoEngine } from "../../services/VideoEngine";
import { useVideoStore } from "../../store/videoStore";
import { useTimelineStore } from "../../store/timelineStore";
import { MediaLibrary } from "../../services/MediaLibrary";
import type { OverlayItem } from "../../store/videoStore";

type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_HANDLES: Array<{ edge: ResizeHandle; cursor: string; style: CSSProperties }> = [
  { edge: "nw", cursor: "nwse-resize", style: { top: 0, left: 0, transform: "translate(-50%, -50%)" } },
  { edge: "n", cursor: "ns-resize", style: { top: 0, left: "50%", transform: "translate(-50%, -50%)" } },
  { edge: "ne", cursor: "nesw-resize", style: { top: 0, right: 0, transform: "translate(50%, -50%)" } },
  { edge: "e", cursor: "ew-resize", style: { top: "50%", right: 0, transform: "translate(50%, -50%)" } },
  { edge: "se", cursor: "nwse-resize", style: { bottom: 0, right: 0, transform: "translate(50%, 50%)" } },
  { edge: "s", cursor: "ns-resize", style: { bottom: 0, left: "50%", transform: "translate(-50%, 50%)" } },
  { edge: "sw", cursor: "nesw-resize", style: { bottom: 0, left: 0, transform: "translate(-50%, 50%)" } },
  { edge: "w", cursor: "ew-resize", style: { top: "50%", left: 0, transform: "translate(-50%, -50%)" } },
];

export function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoSrc = useVideoStore((s) => s.videoSrc);
  const isPlaying = useVideoStore((s) => s.isPlaying);
  const currentTime = useVideoStore((s) => s.currentTime);
  const setIsPlaying = useVideoStore((s) => s.setIsPlaying);
  const setCurrentTime = useVideoStore((s) => s.setCurrentTime);
  const setDuration = useVideoStore((s) => s.setDuration);
  const setVideoDimensions = useVideoStore((s) => s.setVideoDimensions);
  const clips = useVideoStore((s) => s.clips);
  const activeClipId = useVideoStore((s) => s.activeClipId);
  const zoomPercent = useVideoStore((s) => s.zoomPercent);
  const panOffset = useVideoStore((s) => s.panOffset);
  const setPanOffset = useVideoStore((s) => s.setPanOffset);
  const overlays = useVideoStore((s) => s.overlays);
  const showScoreboardOverlay = useVideoStore((s) => s.showScoreboardOverlay);
  const selectedOverlayIds = useVideoStore((s) => s.selectedOverlayIds);
  const setOverlayPosition = useVideoStore((s) => s.setOverlayPosition);
  const setOverlayDimensions = useVideoStore((s) => s.setOverlayDimensions);
  const updateOverlay = useVideoStore((s) => s.updateOverlay);
  const setSelectedOverlayIds = useVideoStore((s) => s.setSelectedOverlayIds);
  const clearOverlaySelection = useVideoStore((s) => s.clearOverlaySelection);
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime);
  const [isDropping, setIsDropping] = useState(false);
  const dragState = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const overlayDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const overlayResizeRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originWidth: number;
    originHeight: number;
    edge: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  } | null>(null);
  const selectedIdsRef = useRef<string[]>([]);

  const handleSelectOverlay = useCallback(
    (id: string, additive: boolean) => {
      const last = selectedOverlayIds;
      let next: string[];
      if (additive) {
        next = last.includes(id)
          ? last.filter((existing) => existing !== id)
          : [...last, id];
      } else {
        next = [id];
      }
      setSelectedOverlayIds(next);
    },
    [selectedOverlayIds, setSelectedOverlayIds]
  );

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.crossOrigin = "anonymous";
      videoRef.current.preload = "auto";
      videoRef.current.playsInline = true;
      videoEngine.attach(videoRef.current);
      videoEngine.setOnTimeUpdate((time) => {
        setCurrentTime(time);
        setPlayheadTime(time);
      });
    }
    return () => {
      videoEngine.detach();
    };
  }, []);

  useEffect(() => {
    if (videoSrc && videoRef.current) {
      videoEngine.loadVideo(videoSrc);
    }
  }, [videoSrc]);

  useEffect(() => {
    selectedIdsRef.current = selectedOverlayIds;
  }, [selectedOverlayIds]);

  useEffect(() => {
    const handleGlobalPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-overlay-node]") || target.closest("[data-video-stage]")) {
        return;
      }
      if (selectedIdsRef.current.length > 0) {
        clearOverlaySelection();
      }
    };

    window.addEventListener("pointerdown", handleGlobalPointerDown);
    return () => window.removeEventListener("pointerdown", handleGlobalPointerDown);
  }, [clearOverlaySelection]);

  const handlePlayPause = useCallback(async () => {
    const element = videoRef.current;
    if (!element) return;
    try {
      if (element.paused) {
        await videoEngine.play();
        setIsPlaying(true);
      } else {
        videoEngine.pause();
        setIsPlaying(false);
      }
    } catch (err) {
      console.error("Failed to toggle playback", err);
    }
  }, [setIsPlaying]);

  const handleLoadedMetadata = () => {
    const element = videoRef.current;
    if (!element) return;
    setDuration(element.duration);
    setVideoDimensions(element.videoWidth, element.videoHeight);
    MediaLibrary.hydrateActiveClip(element, element.duration).catch((err) =>
      console.error("Failed to prepare timeline assets", err)
    );
  };

  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDropping(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const path = (file as any).path as string | undefined;
      if (!path) continue;
      try {
        await MediaLibrary.loadClipFromPath(path);
      } catch (err) {
        console.error(err);
      }
    }
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDropping(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsDropping(false);
    }
  };

  const handleStepForward = () => {
    videoEngine.stepForward();
    setCurrentTime(videoEngine.getCurrentTime());
    setPlayheadTime(videoEngine.getCurrentTime());
  };

  const handleStepBackward = () => {
    videoEngine.stepBackward();
    setCurrentTime(videoEngine.getCurrentTime());
    setPlayheadTime(videoEngine.getCurrentTime());
  };

  const formatTime = (t: number) => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const frames = Math.floor((t % 1) * 60);
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}:${frames.toString().padStart(2, "0")}`;
  };

  const handlePanStart = (e: ReactPointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest("[data-overlay-node]")) {
      clearOverlaySelection();
    }
    if (zoomPercent <= 100 || e.button !== 0) return;
    dragState.current = {
      x: e.clientX,
      y: e.clientY,
      panX: panOffset.x,
      panY: panOffset.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePanMove = (e: ReactPointerEvent) => {
    if (!dragState.current) return;
    e.preventDefault();
    const dx = e.clientX - dragState.current.x;
    const dy = e.clientY - dragState.current.y;
    setPanOffset({ x: dragState.current.panX + dx, y: dragState.current.panY + dy });
  };

  const handlePanEnd = (e: ReactPointerEvent) => {
    if (dragState.current) {
      dragState.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  const scale = zoomPercent / 100;
  const videoTransform = `translate(${panOffset.x}px, ${panOffset.y}px) scale(${scale})`;
  const overlayTransform = `translate(${panOffset.x}px, ${panOffset.y}px)`;
  const renderableOverlays = showScoreboardOverlay
    ? overlays
        .filter((overlay) => overlay.visible)
        .slice()
        .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
    : [];

  const handleOverlayPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    overlay: OverlayItem
  ) => {
    if (overlay.locked || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    handleSelectOverlay(overlay.id, event.metaKey || event.ctrlKey || event.shiftKey);
    overlayDragRef.current = {
      id: overlay.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: overlay.x,
      originY: overlay.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const dragSession = overlayDragRef.current;
    if (dragSession && dragSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = (event.clientX - dragSession.startX) / scale;
      const dy = (event.clientY - dragSession.startY) / scale;
      setOverlayPosition(dragSession.id, dragSession.originX + dx, dragSession.originY + dy);
      return;
    }
    const resizeSession = overlayResizeRef.current;
    if (resizeSession && resizeSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = (event.clientX - resizeSession.startX) / scale;
      const dy = (event.clientY - resizeSession.startY) / scale;
      const minSize = 40;
      let nextWidth = resizeSession.originWidth;
      let nextHeight = resizeSession.originHeight;
      let nextX = resizeSession.originX;
      let nextY = resizeSession.originY;

      if (resizeSession.edge.includes("e")) {
        nextWidth = Math.max(minSize, resizeSession.originWidth + dx);
      }
      if (resizeSession.edge.includes("s")) {
        nextHeight = Math.max(minSize, resizeSession.originHeight + dy);
      }
      if (resizeSession.edge.includes("w")) {
        const width = Math.max(minSize, resizeSession.originWidth - dx);
        nextX = resizeSession.originX + (resizeSession.originWidth - width);
        nextWidth = width;
      }
      if (resizeSession.edge.includes("n")) {
        const height = Math.max(minSize, resizeSession.originHeight - dy);
        nextY = resizeSession.originY + (resizeSession.originHeight - height);
        nextHeight = height;
      }

      setOverlayPosition(resizeSession.id, nextX, nextY);
      setOverlayDimensions(resizeSession.id, nextWidth, nextHeight);
    }
  };

  const handleOverlayPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (overlayDragRef.current && overlayDragRef.current.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      overlayDragRef.current = null;
    }
    if (overlayResizeRef.current && overlayResizeRef.current.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      overlayResizeRef.current = null;
    }
  };

  const handleOverlayDoubleClick = (overlay: OverlayItem) => {
    if (overlay.locked || overlay.type !== "text" || !overlay.text) {
      return;
    }
    const next = window.prompt("Overlay text", overlay.text);
    if (next !== null) {
      const trimmed = next.trim();
      if (trimmed) {
        updateOverlay(overlay.id, { text: trimmed });
      }
    }
  };

  const handleOverlayResizePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    overlay: OverlayItem,
    edge: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
  ) => {
    if (overlay.locked) return;
    event.stopPropagation();
    event.preventDefault();
    if (!selectedOverlayIds.includes(overlay.id)) {
      handleSelectOverlay(overlay.id, event.metaKey || event.ctrlKey || event.shiftKey);
    }
    overlayResizeRef.current = {
      id: overlay.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: overlay.x,
      originY: overlay.y,
      originWidth: overlay.width,
      originHeight: overlay.height,
      edge,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col bg-surface-dark"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className="flex-1 flex overflow-hidden">
        <div className="w-20 bg-surface border-r border-panel-border flex flex-col gap-2 p-2 overflow-y-auto">
          {clips.map((clip) => (
            <button
              key={clip.id}
              title={clip.name}
              onClick={() =>
                MediaLibrary.activateClip(clip.id).catch((err) =>
                  console.error("Failed to activate clip", err)
                )
              }
              className={`h-16 w-full rounded overflow-hidden border transition-all ${
                clip.id === activeClipId ? "border-accent shadow-lg" : "border-panel-border"
              }`}
            >
              {clip.thumbnail ? (
                <img
                  src={clip.thumbnail}
                  alt={clip.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-surface-light text-xs text-gray-400 flex items-center justify-center">
                  {clip.name.slice(0, 4).toUpperCase()}
                </div>
              )}
            </button>
          ))}
        </div>
        <div
          className="flex-1 relative flex items-center justify-center overflow-hidden"
          data-video-stage
          onPointerDown={handlePanStart}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanEnd}
          onPointerLeave={handlePanEnd}
        >
          {!videoSrc && (
            <div className="text-gray-500 text-center">
              <p className="text-lg mb-2">Drop a video file here</p>
              <p className="text-sm">or use the Load Video button</p>
            </div>
          )}
          {isDropping && (
            <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent pointer-events-none" />
          )}
          <video
            ref={videoRef}
            className={`max-w-none max-h-none ${!videoSrc ? "hidden" : ""}`}
            style={{
              transform: videoTransform,
              transformOrigin: "50% 50%",
              transition: dragState.current ? "none" : "transform 0.08s ease-out",
            }}
            crossOrigin="anonymous"
            preload="auto"
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={handlePlay}
            onPause={handlePause}
          />
          {videoSrc && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                transform: overlayTransform,
                transition: dragState.current ? "none" : "transform 0.08s ease-out",
                transformOrigin: "50% 50%",
              }}
            >
              {renderableOverlays.map((overlay) => {
                  const isSelected = selectedOverlayIds.includes(overlay.id);
                  const isLocked = Boolean(overlay.locked);
                  const handleMessage =
                    overlay.type === "text"
                      ? "Drag to reposition. Double-click to edit."
                      : overlay.type === "image"
                        ? "Drag to reposition. Use handles to resize."
                        : "Scoreboard overlay";
                  const commonHandlers = isLocked
                    ? {}
                    : {
                        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) =>
                          handleOverlayPointerDown(event, overlay),
                        onPointerMove: handleOverlayPointerMove,
                        onPointerUp: handleOverlayPointerUp,
                        onPointerCancel: handleOverlayPointerUp,
                        onDoubleClick: () => handleOverlayDoubleClick(overlay),
                      };

                  return (
                    <div
                      key={overlay.id}
                      data-overlay-node
                      className={`absolute select-none ${
                        isLocked ? "pointer-events-none" : "pointer-events-auto cursor-move"
                      } ${
                        isSelected && !isLocked ? "ring-2 ring-accent/80" : "ring-1 ring-black/30"
                      } rounded shadow-lg shadow-black/40 ${
                        overlay.type === "image" ? "bg-transparent" : "bg-black/60"
                      } ${overlay.type === "image" ? "" : "text-white"}`}
                      style={{
                        left: overlay.x,
                        top: overlay.y,
                        width: overlay.width,
                        height: overlay.height,
                        zIndex: overlay.zIndex ?? 0,
                        fontFamily: overlay.fontFamily,
                        fontSize: overlay.fontSize,
                        color: overlay.color,
                      }}
                      title={handleMessage}
                      {...commonHandlers}
                    >
                      {overlay.type === "image" && overlay.imageSrc ? (
                        <img
                          src={overlay.imageSrc}
                          alt="Overlay"
                          className="h-full w-full object-contain"
                          draggable={false}
                        />
                      ) : (
                        <div className="h-full w-full break-words px-3 py-2 flex items-center justify-center text-center">
                          {overlay.text}
                        </div>
                      )}
                      {isSelected && !isLocked && (
                        <>
                          {RESIZE_HANDLES.map(({ edge, cursor, style }) => (
                            <button
                              key={`${overlay.id}-${edge}`}
                              type="button"
                              className="absolute h-3 w-3 rounded-full bg-white shadow"
                              style={{ cursor, ...style }}
                              onPointerDown={(event) =>
                                handleOverlayResizePointerDown(event, overlay, edge)
                              }
                              onPointerMove={handleOverlayPointerMove}
                              onPointerUp={handleOverlayPointerUp}
                              onPointerCancel={handleOverlayPointerUp}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
      <div className="h-10 bg-panel border-t border-panel-border flex items-center px-4 gap-3 shrink-0">
        <button
          onClick={handleStepBackward}
          className="text-gray-400 hover:text-white text-sm transition-colors"
          title="Step Back (1 frame)"
        >
          ⏮
        </button>
        <button
          onClick={handlePlayPause}
          className="text-white hover:text-accent text-lg transition-colors"
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button
          onClick={handleStepForward}
          className="text-gray-400 hover:text-white text-sm transition-colors"
          title="Step Forward (1 frame)"
        >
          ⏭
        </button>
        <span className="text-xs text-gray-400 font-mono ml-2">
          {formatTime(currentTime)}
        </span>
      </div>
    </div>
  );
}
