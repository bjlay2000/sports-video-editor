import {
  useRef,
  useEffect,
  useCallback,
  useState,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { videoEngine } from "../../services/VideoEngine";
import { useVideoStore } from "../../store/videoStore";
import { useTimelineStore } from "../../store/timelineStore";
import { useAppStore } from "../../store/appStore";
import { MediaLibrary } from "../../services/MediaLibrary";
import { getRenderState } from "../../engine/RenderEngine";
import { renderFrameSync, preloadImages } from "../../engine/CanvasCompositor";
import { deriveScoreEvents } from "../../engine/scoreEvents";
import type { ComputedOverlay, TimelineModel } from "../../engine/types";

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
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
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
  const plays = useAppStore((s) => s.plays);
  const opponentScoreEvents = useAppStore((s) => s.opponentScoreEvents);
  const duration = useVideoStore((s) => s.duration);
  const videoWidth = useVideoStore((s) => s.videoWidth);
  const videoHeight = useVideoStore((s) => s.videoHeight);
  const videoTrackKeyframes = useVideoStore((s) => s.videoTrackKeyframes);
  const [isDropping, setIsDropping] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
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
      // Don't clear selection when clicking overlay nodes, the video stage,
      // or any button / interactive element outside the video area (e.g. toolbar delete)
      if (
        target.closest("[data-overlay-node]") ||
        target.closest("[data-video-stage]") ||
        target.closest("[data-timeline-controls]") ||
        target.closest("button")
      ) {
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

  // ---- Unified render pipeline ----
  const scoreEvents = useMemo(
    () => deriveScoreEvents(plays, opponentScoreEvents),
    [plays, opponentScoreEvents],
  );

  const timelineModel = useMemo<TimelineModel>(
    () => ({
      duration: duration || 0,
      currentTime,
      overlays: showScoreboardOverlay ? overlays : [],
      scoreEvents: showScoreboardOverlay ? scoreEvents : [],
      videoTrack: {
        keyframes:
          videoTrackKeyframes.length > 0
            ? videoTrackKeyframes
            : [{ time: 0, scale: zoomPercent / 100, x: panOffset.x, y: panOffset.y }],
      },
    }),
    [duration, currentTime, overlays, scoreEvents, videoTrackKeyframes, showScoreboardOverlay, zoomPercent, panOffset],
  );

  const renderState = useMemo(
    () => getRenderState(timelineModel, currentTime),
    [timelineModel, currentTime],
  );

  const renderableOverlays = renderState.overlays;

  // Sync canvas resolution to video native dimensions
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || videoWidth === 0 || videoHeight === 0) return;
    if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
      canvas.width = videoWidth;
      canvas.height = videoHeight;
    }
    // CSS sizing fills the container; resolution matches the video
    canvas.style.width = "100%";
    canvas.style.height = "100%";
  }, [videoWidth, videoHeight]);

  // Canvas overlay rendering
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const selectedSet = new Set(selectedOverlayIds);
    renderFrameSync(ctx, renderState, canvas.width, canvas.height, selectedSet);
  }, [renderState, selectedOverlayIds, imageVersion]);

  // Pre-load overlay images for sync rendering
  useEffect(() => {
    if (renderableOverlays.some((o) => o.type === "image" && o.imageSrc)) {
      preloadImages(renderableOverlays).then(() => {
        setImageVersion((v) => v + 1);
      });
    }
  }, [renderableOverlays]);

  const handleOverlayPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    overlay: ComputedOverlay
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    handleSelectOverlay(overlay.id, event.metaKey || event.ctrlKey || event.shiftKey);
    overlayDragRef.current = {
      id: overlay.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: overlay.x,  // video pixel space
      originY: overlay.y,  // video pixel space
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    // Compute DOM→video pixel scale from the canvas element (which fills the container
    // via inset-0 and has internal resolution = videoWidth × videoHeight).
    const canvas = overlayCanvasRef.current;
    const cw = canvas?.clientWidth || 1;
    const ch = canvas?.clientHeight || 1;
    const scaleX = videoWidth / cw;
    const scaleY = videoHeight / ch;

    const dragSession = overlayDragRef.current;
    if (dragSession && dragSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = (event.clientX - dragSession.startX) * scaleX;
      const dy = (event.clientY - dragSession.startY) * scaleY;
      setOverlayPosition(dragSession.id, dragSession.originX + dx, dragSession.originY + dy);
      return;
    }
    const resizeSession = overlayResizeRef.current;
    if (resizeSession && resizeSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = (event.clientX - resizeSession.startX) * scaleX;
      const dy = (event.clientY - resizeSession.startY) * scaleY;
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

  const handleOverlayDoubleClick = (overlay: ComputedOverlay) => {
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
    overlay: ComputedOverlay,
    edge: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
  ) => {
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
              position: "relative",
              zIndex: 0,
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
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 pointer-events-none"
              style={{
                zIndex: 10,
                transform: overlayTransform,
                transition: dragState.current ? "none" : "transform 0.08s ease-out",
                transformOrigin: "50% 50%",
              }}
            />
          )}
          {videoSrc && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                zIndex: 20,
                transform: overlayTransform,
                transition: dragState.current ? "none" : "transform 0.08s ease-out",
                transformOrigin: "50% 50%",
              }}
            >
              {renderableOverlays.map((overlay) => {
                  const isSelected = selectedOverlayIds.includes(overlay.id);
                  const isScoreboard = overlay.type === "scoreboard";
                  const handleMessage =
                    overlay.type === "text"
                      ? "Drag to reposition. Double-click to edit."
                      : overlay.type === "image"
                        ? "Drag to reposition. Use handles to resize."
                        : "Scoreboard overlay (drag to reposition)";
                  const commonHandlers = {
                        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) =>
                          handleOverlayPointerDown(event, overlay),
                        onPointerMove: handleOverlayPointerMove,
                        onPointerUp: handleOverlayPointerUp,
                        onPointerCancel: handleOverlayPointerUp,
                        onDoubleClick: () => handleOverlayDoubleClick(overlay),
                      };

                  // Convert video-pixel coords → percentage of container
                  // (canvas fills container via inset-0 and maps its internal
                  //  videoWidth×videoHeight to that same area)
                  const pctX = videoWidth  > 0 ? (overlay.x / videoWidth) * 100 : 0;
                  const pctY = videoHeight > 0 ? (overlay.y / videoHeight) * 100 : 0;
                  const pctW = videoWidth  > 0 ? (overlay.width / videoWidth) * 100 : 0;
                  const pctH = videoHeight > 0 ? (overlay.height / videoHeight) * 100 : 0;

                  return (
                    <div
                      key={overlay.id}
                      data-overlay-node
                      className="absolute select-none pointer-events-auto cursor-move"
                      style={{
                        left: `${pctX}%`,
                        top: `${pctY}%`,
                        width: `${pctW}%`,
                        height: `${pctH}%`,
                        zIndex: overlay.zIndex,
                      }}
                      title={handleMessage}
                      {...commonHandlers}
                    >
                      {isSelected && !isScoreboard && (
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
