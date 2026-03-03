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
import { preloadImages } from "../../engine/CanvasCompositor";
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
  const stageRef = useRef<HTMLDivElement>(null);
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
  const viewport = useVideoStore((s) => s.viewport);
  const setViewport = useVideoStore((s) => s.setViewport);
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
  const homeScoreEvents = useAppStore((s) => s.homeScoreEvents);
  const duration = useVideoStore((s) => s.duration);
  const videoWidth = useVideoStore((s) => s.videoWidth);
  const videoHeight = useVideoStore((s) => s.videoHeight);
  const videoTrackKeyframes = useVideoStore((s) => s.videoTrackKeyframes);
  const [isDropping, setIsDropping] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const dragState = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const overlayDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    scaleX: number;
    scaleY: number;
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
    originAspect: number;
    originFontSize: number | null;
    edge: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
    scaleX: number;
    scaleY: number;
  } | null>(null);
  const selectedIdsRef = useRef<string[]>([]);

  const isInteractiveElement = useCallback((target: HTMLElement) => {
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("select") ||
      target.closest("option") ||
      target.closest("textarea") ||
      target.closest("label") ||
      target.closest("a")
    ) {
      return true;
    }

    return target.isContentEditable;
  }, []);

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

  // Track the video‑stage container size so we can compute a fit scale
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setStageSize({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
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
        isInteractiveElement(target)
      ) {
        return;
      }
      if (selectedIdsRef.current.length > 0) {
        clearOverlaySelection();
      }
    };

    window.addEventListener("pointerdown", handleGlobalPointerDown);
    return () => window.removeEventListener("pointerdown", handleGlobalPointerDown);
  }, [clearOverlaySelection, isInteractiveElement]);

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
      panX: viewport.panX,
      panY: viewport.panY,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePanMove = (e: ReactPointerEvent) => {
    if (!dragState.current) return;
    e.preventDefault();
    const dx = e.clientX - dragState.current.x;
    const dy = e.clientY - dragState.current.y;
    // Convert screen‑pixel drag to native‑video‑pixel offset
    const screenToNative = videoWidth > 0 && monitorW > 0 ? videoWidth / monitorW : 1;
    const newPanX = dragState.current.panX - (dx * screenToNative) / viewport.zoom;
    const newPanY = dragState.current.panY - (dy * screenToNative) / viewport.zoom;
    const maxPanX = Math.max(0, videoWidth - videoWidth / viewport.zoom);
    const maxPanY = Math.max(0, videoHeight - videoHeight / viewport.zoom);
    setViewport({
      panX: Math.max(0, Math.min(maxPanX, newPanX)),
      panY: Math.max(0, Math.min(maxPanY, newPanY)),
    });
  };

  const handlePanEnd = (e: ReactPointerEvent) => {
    if (dragState.current) {
      dragState.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  // ── Monitor dimensions: the video fits inside the stage like Filmora ──
  // The "monitor" is the largest rect with the video's aspect ratio that
  // fits inside the stage container — the video fills this rect exactly.
  const videoAspect = videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : 16 / 9;
  const monitorW = useMemo(() => {
    if (stageSize.width <= 0 || stageSize.height <= 0) return 0;
    const byWidth = stageSize.width;
    const byHeight = stageSize.height * videoAspect;
    return Math.min(byWidth, byHeight);
  }, [stageSize.width, stageSize.height, videoAspect]);
  const monitorH = useMemo(() => {
    return monitorW > 0 ? monitorW / videoAspect : 0;
  }, [monitorW, videoAspect]);

  // ---- Unified render pipeline ----
  const scoreEvents = useMemo(
    () => deriveScoreEvents(plays, opponentScoreEvents, homeScoreEvents),
    [plays, opponentScoreEvents, homeScoreEvents],
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
  const selectedOverlay = useMemo(() => {
    if (selectedOverlayIds.length === 0) return null;
    return renderableOverlays.find((overlay) => overlay.id === selectedOverlayIds[0]) ?? null;
  }, [renderableOverlays, selectedOverlayIds]);
  const selectedTextOverlay = useMemo(
    () => (selectedOverlay && (selectedOverlay.type === "text" || selectedOverlay.type === "scoreboard")
      ? selectedOverlay
      : null),
    [selectedOverlay],
  );
  const fontOptions = useMemo(
    () => [
      "Inter, sans-serif",
      "Arial, sans-serif",
      "Segoe UI, sans-serif",
      "Tahoma, sans-serif",
      "Verdana, sans-serif",
      "Trebuchet MS, sans-serif",
      "Georgia, serif",
      "Times New Roman, serif",
      "Courier New, monospace",
      "Consolas, monospace",
    ],
    [],
  );

  // Sync canvas resolution to video native dimensions
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || videoWidth === 0 || videoHeight === 0) return;
    if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
      canvas.width = videoWidth;
      canvas.height = videoHeight;
    }
  }, [videoWidth, videoHeight]);

  // Canvas overlay rendering — overlays are now rendered as HTML elements for live preview
  // so we just clear the canvas here to avoid double-drawing.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    const dragScaleX = videoWidth > 0 && monitorW > 0 ? videoWidth / (monitorW * viewport.zoom) : 1;
    const dragScaleY = videoHeight > 0 && monitorH > 0 ? videoHeight / (monitorH * viewport.zoom) : 1;
    overlayDragRef.current = {
      id: overlay.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: overlay.x,  // video pixel space
      originY: overlay.y,  // video pixel space
      scaleX: dragScaleX,
      scaleY: dragScaleY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const dragSession = overlayDragRef.current;
    if (dragSession && dragSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = (event.clientX - dragSession.startX) * dragSession.scaleX;
      const dy = (event.clientY - dragSession.startY) * dragSession.scaleY;
      setOverlayPosition(dragSession.id, dragSession.originX + dx, dragSession.originY + dy);
      return;
    }
    const resizeSession = overlayResizeRef.current;
    if (resizeSession && resizeSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = (event.clientX - resizeSession.startX) * resizeSession.scaleX;
      const dy = (event.clientY - resizeSession.startY) * resizeSession.scaleY;
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

      // Keep aspect ratio only while Shift is held.
      if (event.shiftKey) {
        const aspect = resizeSession.originAspect > 0 ? resizeSession.originAspect : (resizeSession.originWidth / Math.max(1, resizeSession.originHeight));

        if (resizeSession.edge === "e" || resizeSession.edge === "w") {
          nextHeight = Math.max(minSize, nextWidth / aspect);
          if (resizeSession.edge.includes("n")) {
            nextY = resizeSession.originY + (resizeSession.originHeight - nextHeight);
          }
        } else if (resizeSession.edge === "n" || resizeSession.edge === "s") {
          nextWidth = Math.max(minSize, nextHeight * aspect);
          if (resizeSession.edge.includes("w")) {
            nextX = resizeSession.originX + (resizeSession.originWidth - nextWidth);
          }
        } else {
          // Corner resize: use dominant axis and project the other to keep ratio.
          const widthFromHeight = nextHeight * aspect;
          const heightFromWidth = nextWidth / aspect;
          if (Math.abs(nextWidth - resizeSession.originWidth) >= Math.abs(nextHeight - resizeSession.originHeight)) {
            nextHeight = Math.max(minSize, heightFromWidth);
          } else {
            nextWidth = Math.max(minSize, widthFromHeight);
          }
          if (resizeSession.edge.includes("w")) {
            nextX = resizeSession.originX + (resizeSession.originWidth - nextWidth);
          }
          if (resizeSession.edge.includes("n")) {
            nextY = resizeSession.originY + (resizeSession.originHeight - nextHeight);
          }
        }
      }

      setOverlayPosition(resizeSession.id, nextX, nextY);
      setOverlayDimensions(resizeSession.id, nextWidth, nextHeight);

      if (resizeSession.originFontSize && resizeSession.originFontSize > 0) {
        const scaleRatio = nextWidth / Math.max(1, resizeSession.originWidth);
        const nextFontSize = Math.max(8, Math.round(resizeSession.originFontSize * scaleRatio));
        updateOverlay(resizeSession.id, { fontSize: nextFontSize });
      }
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
    const resizeScaleX = videoWidth > 0 && monitorW > 0 ? videoWidth / (monitorW * viewport.zoom) : 1;
    const resizeScaleY = videoHeight > 0 && monitorH > 0 ? videoHeight / (monitorH * viewport.zoom) : 1;
    overlayResizeRef.current = {
      id: overlay.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: overlay.x,
      originY: overlay.y,
      originWidth: overlay.width,
      originHeight: overlay.height,
      originAspect: overlay.width > 0 && overlay.height > 0 ? overlay.width / overlay.height : 1,
      originFontSize: overlay.type === "text" || overlay.type === "scoreboard"
        ? (overlay.fontSize ?? null)
        : null,
      edge,
      scaleX: resizeScaleX,
      scaleY: resizeScaleY,
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
          ref={stageRef}
          className="flex-1 relative overflow-hidden bg-black"
          data-video-stage
          onPointerDown={handlePanStart}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanEnd}
          onPointerLeave={handlePanEnd}
        >
          {!videoSrc && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-gray-500 text-center">
                <p className="text-lg mb-2">Drop a video file here</p>
                <p className="text-sm">or use the Load Video button</p>
              </div>
            </div>
          )}
          {isDropping && (
            <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent pointer-events-none" />
          )}
          {/* 
            Monitor: aspect‑ratio‑locked box centered in the stage.
            At 100% zoom the video fills this box exactly (like Filmora).
            Zoom > 100% scales up inside; overflow is clipped.
          */}
          <div
            className="absolute overflow-hidden"
            style={{
              width: monitorW || "100%",
              height: monitorH || "100%",
              left: monitorW > 0 ? (stageSize.width - monitorW) / 2 : 0,
              top: monitorH > 0 ? (stageSize.height - monitorH) / 2 : 0,
            }}
          >
            {/* Inner scene: sized to monitor, zoomed/panned via CSS */}
            <div
              style={{
                position: "absolute",
                width: "100%",
                height: "100%",
                transform: `scale(${viewport.zoom}) translate(${-(viewport.panX / (videoWidth || 1)) * 100}%, ${-(viewport.panY / (videoHeight || 1)) * 100}%)`,
                transformOrigin: "0 0",
                transition: dragState.current ? "none" : "transform 0.08s ease-out",
              }}
            >
              <video
                ref={videoRef}
                className={!videoSrc ? "hidden" : ""}
                style={{ width: "100%", height: "100%", display: videoSrc ? "block" : "none" }}
                crossOrigin="anonymous"
                preload="auto"
                playsInline
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={handlePlay}
                onPause={handlePause}
              />
                <canvas
                  ref={overlayCanvasRef}
                  className="absolute inset-0 pointer-events-none"
                  style={{ zIndex: 10 }}
                />
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{ zIndex: 20 }}
                >
                  {renderableOverlays.map((overlay) => {
                      const isSelected = selectedOverlayIds.includes(overlay.id);
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

                      const screenScaleX = videoWidth > 0 && monitorW > 0 ? monitorW / videoWidth : 0;
                      const screenScaleY = videoHeight > 0 && monitorH > 0 ? monitorH / videoHeight : 0;
                      const boxLeft = overlay.x * screenScaleX;
                      const boxTop = overlay.y * screenScaleY;
                      const boxWidth = overlay.width * screenScaleX;
                      const boxHeight = overlay.height * screenScaleY;

                      const borderRadius = overlay.type === "image" ? "4px" : "12px";

                      return (
                        <div
                          key={overlay.id}
                          data-overlay-node
                          className="absolute select-none pointer-events-auto cursor-move"
                          style={{
                            left: `${boxLeft}px`,
                            top: `${boxTop}px`,
                            width: `${boxWidth}px`,
                            height: `${boxHeight}px`,
                            zIndex: overlay.zIndex,
                          }}
                          title={handleMessage}
                          {...commonHandlers}
                        >
                          {/* Visual content — rendered directly in this div so visual and interaction are one element */}
                          {overlay.type === "image" && overlay.imageSrc ? (
                            <img
                              src={overlay.imageSrc}
                              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
                              draggable={false}
                              alt=""
                            />
                          ) : (
                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                borderRadius,
                                backgroundColor: "rgba(0,0,0,0.6)",
                                boxShadow: "0 4px 15px rgba(0,0,0,0.4)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                overflow: "hidden",
                                pointerEvents: "none",
                              }}
                            >
                              {overlay.text && (
                                <span
                                  style={{
                                    color: overlay.color ?? "#ffffff",
                                    fontSize: `${(overlay.fontSize ?? 24) * screenScaleX}px`,
                                    fontFamily: overlay.fontFamily ?? "Inter, sans-serif",
                                    textAlign: "center",
                                    lineHeight: 1.1,
                                    padding: `0 ${12 * screenScaleX}px`,
                                    wordBreak: "break-word",
                                    userSelect: "none",
                                  }}
                                >
                                  {overlay.text}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Selection ring */}
                          {isSelected && (
                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                borderRadius,
                                border: "2px solid rgba(233,69,96,0.8)",
                                pointerEvents: "none",
                                zIndex: 1,
                              }}
                            />
                          )}

                          {/* Resize handles — always available for all overlay types */}
                          {isSelected && (
                            <>
                              {RESIZE_HANDLES.map(({ edge, cursor, style }) => (
                                <button
                                  key={`${overlay.id}-${edge}`}
                                  type="button"
                                  className="absolute h-3 w-3 rounded-full bg-white shadow"
                                  style={{ cursor, zIndex: 2, ...style }}
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
              </div>
            </div>
          {/* Export area border — always visible; dashed & brighter when zoomed in */}
          {videoSrc && monitorW > 0 && (
            <div
              className="absolute pointer-events-none"
              style={{
                width: monitorW,
                height: monitorH,
                left: monitorW > 0 ? (stageSize.width - monitorW) / 2 : 0,
                top: monitorH > 0 ? (stageSize.height - monitorH) / 2 : 0,
                zIndex: 31,
                border: viewport.zoom > 1
                  ? "1.5px dashed rgba(255,255,255,0.5)"
                  : "1px solid rgba(255,255,255,0.1)",
              }}
            />
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
      {selectedTextOverlay && (
        <div className="border-t border-panel-border bg-surface px-4 py-2 flex items-center gap-3 text-xs">
          <span className="text-gray-400 uppercase tracking-wider">Text</span>
          <label className="flex items-center gap-2 text-gray-300">
            <span>Font</span>
            <select
              value={selectedTextOverlay.fontFamily ?? "Inter, sans-serif"}
              onChange={(event) => updateOverlay(selectedTextOverlay.id, { fontFamily: event.target.value })}
              className="px-2 py-1 bg-panel border border-panel-border rounded text-xs text-white"
            >
              {fontOptions.map((font) => (
                <option key={font} value={font}>{font.split(",")[0]}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-gray-300">
            <span>Size</span>
            <input
              type="number"
              min={8}
              max={200}
              value={Math.max(8, Math.round(selectedTextOverlay.fontSize ?? 24))}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (!Number.isFinite(parsed)) return;
                updateOverlay(selectedTextOverlay.id, { fontSize: Math.max(8, Math.min(200, parsed)) });
              }}
              className="w-20 px-2 py-1 bg-panel border border-panel-border rounded text-xs text-white"
            />
          </label>
          <span className="text-gray-500">Hold Shift while resizing to keep aspect ratio</span>
        </div>
      )}
    </div>
  );
}
