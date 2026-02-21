import { create } from "zustand";
import { TimelineThumbnail } from "./timelineStore";
import type { Overlay, VideoTrackKeyframe } from "../engine/types";

export type { Overlay };
export type OverlayKind = Overlay["type"];

export interface MediaClip {
  id: string;
  path: string;
  name: string;
  src: string;
  duration?: number;
  thumbnail?: string;
  assets?: {
    thumbnails: TimelineThumbnail[];
    waveformSrc: string | null;
  };
}

type OverlayShiftDirection = "forward" | "backward";

const resolveZIndex = (overlay: Overlay, fallback: number) =>
  typeof overlay.zIndex === "number" ? overlay.zIndex : fallback;

const nextZIndex = (overlays: Overlay[]) => {
  if (overlays.length === 0) return 1;
  return (
    overlays.reduce(
      (max, overlay, idx) => Math.max(max, resolveZIndex(overlay, idx)),
      0
    ) + 1
  );
};

const shiftOverlayOrder = (
  overlays: Overlay[],
  selectedIds: string[],
  direction: OverlayShiftDirection
) => {
  if (!selectedIds.length) {
    return overlays;
  }
  const idSet = new Set(selectedIds);
  const sorted = [...overlays]
    .map((overlay, idx) => ({ ...overlay, zIndex: resolveZIndex(overlay, idx) }))
    .sort((a, b) => a.zIndex - b.zIndex);

  let mutated = false;
  if (direction === "forward") {
    for (let i = sorted.length - 2; i >= 0; i -= 1) {
      const current = sorted[i];
      const above = sorted[i + 1];
      if (idSet.has(current.id) && !idSet.has(above.id)) {
        [current.zIndex, above.zIndex] = [above.zIndex, current.zIndex];
        mutated = true;
      }
    }
  } else {
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i];
      const below = sorted[i - 1];
      if (idSet.has(current.id) && !idSet.has(below.id)) {
        [current.zIndex, below.zIndex] = [below.zIndex, current.zIndex];
        mutated = true;
      }
    }
  }

  if (!mutated) {
    return overlays;
  }

  const zLookup = new Map(sorted.map((overlay) => [overlay.id, overlay.zIndex]));
  return overlays.map((overlay, idx) => {
    const nextZ = zLookup.get(overlay.id) ?? resolveZIndex(overlay, idx);
    if (nextZ === overlay.zIndex) {
      return overlay;
    }
    return { ...overlay, zIndex: nextZ };
  });
};

interface VideoState {
  videoSrc: string | null;
  videoPath: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  clips: MediaClip[];
  activeClipId: string | null;
  zoomPercent: number;
  panOffset: { x: number; y: number };
  keyframeMode: boolean;
  overlays: Overlay[];
  videoTrackKeyframes: VideoTrackKeyframe[];
  selectedOverlayIds: string[];
  showScoreboardOverlay: boolean;
  setVideoSrc: (src: string | null) => void;
  setVideoPath: (path: string | null) => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setVideoDimensions: (width: number, height: number) => void;
  registerClip: (clip: MediaClip) => void;
  updateClip: (id: string, patch: Partial<MediaClip>) => void;
  setActiveClip: (id: string | null) => void;
  setZoomPercent: (percent: number) => void;
  setPanOffset: (offset: { x: number; y: number }) => void;
  resetTransform: () => void;
  toggleKeyframeMode: () => void;
  addTextOverlay: (overlay?: Partial<Overlay>) => string;
  addImageOverlay: (imageSrc: string, overlay?: Partial<Overlay>) => string;
  updateOverlay: (id: string, patch: Partial<Overlay>) => void;
  setOverlayVisibility: (id: string, visible: boolean) => void;
  setOverlayPosition: (id: string, x: number, y: number) => void;
  setOverlayDimensions: (id: string, width: number, height: number) => void;
  removeOverlays: (ids: string[]) => void;
  setSelectedOverlayIds: (ids: string[]) => void;
  clearOverlaySelection: () => void;
  bringSelectionForward: () => void;
  sendSelectionBackward: () => void;
  setVideoTrackKeyframes: (kfs: VideoTrackKeyframe[]) => void;
  addVideoTrackKeyframe: (kf: VideoTrackKeyframe) => void;
  toggleScoreboardOverlay: (visible: boolean) => void;
}

const createOverlayId = () =>
  `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useVideoStore = create<VideoState>((set, get) => ({
  videoSrc: null,
  videoPath: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  videoWidth: 0,
  videoHeight: 0,
  clips: [],
  activeClipId: null,
  zoomPercent: 100,
  panOffset: { x: 0, y: 0 },
  keyframeMode: false,
  overlays: [
    {
      id: "score-home",
      type: "scoreboard",
      zIndex: 1,
      startTime: 0,
      endTime: Infinity,
      base: { x: 40, y: 40, width: 180, height: 54 },
      keyframes: [],
      text: "HOME",
      fontFamily: "Inter, sans-serif",
      fontSize: 32,
      color: "#ffffff",
      visible: true,
      locked: true,
      dynamic: { type: "scoreboard" },
    },
    {
      id: "score-away",
      type: "scoreboard",
      zIndex: 2,
      startTime: 0,
      endTime: Infinity,
      base: { x: 220, y: 40, width: 180, height: 54 },
      keyframes: [],
      text: "AWAY",
      fontFamily: "Inter, sans-serif",
      fontSize: 32,
      color: "#ffffff",
      visible: true,
      locked: true,
      dynamic: { type: "scoreboard" },
    },
  ],
  videoTrackKeyframes: [],
  selectedOverlayIds: [],
  showScoreboardOverlay: true,
  setVideoSrc: (src) => set({ videoSrc: src }),
  setVideoPath: (path) => set({ videoPath: path }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration }),
  setVideoDimensions: (width, height) =>
    set({
      videoWidth: Math.max(0, Math.floor(width)),
      videoHeight: Math.max(0, Math.floor(height)),
    }),
  registerClip: (clip) =>
    set((state) => {
      const existing = state.clips.find((c) => c.path === clip.path);
      if (existing) {
        return {
          clips: state.clips.map((c) => (c.id === existing.id ? { ...existing, ...clip } : c)),
          activeClipId: existing.id,
        };
      }
      return {
        clips: [...state.clips, clip],
        activeClipId: clip.id,
      };
    }),
  updateClip: (id, patch) =>
    set((state) => ({
      clips: state.clips.map((clip) =>
        clip.id === id
          ? {
              ...clip,
              ...patch,
              assets: patch.assets ?? clip.assets,
            }
          : clip
      ),
    })),
  setActiveClip: (id) => set({ activeClipId: id }),
  setZoomPercent: (percent) =>
    set((state) => {
      const clamped = Math.max(0, Math.min(300, percent));
      return {
        zoomPercent: clamped,
        panOffset: clamped <= 100 ? { x: 0, y: 0 } : state.panOffset,
      };
    }),
  setPanOffset: (offset) =>
    set((state) => ({
      panOffset:
        state.zoomPercent <= 100
          ? { x: 0, y: 0 }
          : { x: offset.x, y: offset.y },
    })),
  resetTransform: () => set({ zoomPercent: 100, panOffset: { x: 0, y: 0 } }),
  toggleKeyframeMode: () =>
    set((state) => ({
      keyframeMode: !state.keyframeMode,
    })),
  addTextOverlay: (overlay) => {
    const id = createOverlayId();
    const next: Overlay = {
      id,
      type: overlay?.type ?? "text",
      zIndex: overlay?.zIndex ?? nextZIndex(get().overlays),
      startTime: overlay?.startTime ?? 0,
      endTime: overlay?.endTime ?? Infinity,
      base: overlay?.base ?? { x: 80, y: 120, width: 240, height: 80 },
      keyframes: overlay?.keyframes ?? [],
      text: overlay?.text ?? "New Text",
      fontFamily: overlay?.fontFamily ?? "Inter, sans-serif",
      fontSize: overlay?.fontSize ?? 24,
      color: overlay?.color ?? "#ffffff",
      visible: overlay?.visible ?? true,
    };
    set((state) => ({
      overlays: [...state.overlays, next],
      selectedOverlayIds: [id],
    }));
    return id;
  },
  addImageOverlay: (imageSrc, overlay) => {
    const id = createOverlayId();
    const next: Overlay = {
      id,
      type: "image",
      zIndex: overlay?.zIndex ?? nextZIndex(get().overlays),
      startTime: overlay?.startTime ?? 0,
      endTime: overlay?.endTime ?? Infinity,
      base: overlay?.base ?? { x: 120, y: 140, width: 320, height: 180 },
      keyframes: overlay?.keyframes ?? [],
      imageSrc,
      visible: overlay?.visible ?? true,
    };
    set((state) => ({
      overlays: [...state.overlays, next],
      selectedOverlayIds: [id],
    }));
    return id;
  },
  updateOverlay: (id, patch) =>
    set((state) => ({
      overlays: state.overlays.map((overlay) =>
        overlay.id === id ? { ...overlay, ...patch } : overlay
      ),
    })),
  setOverlayVisibility: (id, visible) =>
    set((state) => ({
      overlays: state.overlays.map((overlay) =>
        overlay.id === id ? { ...overlay, visible } : overlay
      ),
    })),
  setOverlayPosition: (id, x, y) =>
    set((state) => ({
      overlays: state.overlays.map((overlay) =>
        overlay.id === id
          ? { ...overlay, base: { ...overlay.base, x, y } }
          : overlay
      ),
    })),
  setOverlayDimensions: (id, width, height) =>
    set((state) => ({
      overlays: state.overlays.map((overlay) =>
        overlay.id === id
          ? { ...overlay, base: { ...overlay.base, width, height } }
          : overlay
      ),
    })),
  removeOverlays: (ids) => {
    const state = get();
    console.log("[delete] selectedOverlayIds:", state.selectedOverlayIds, "ids to remove:", ids);
    set({
      overlays: state.overlays.filter(
        (o) => !ids.includes(o.id) || o.type === "scoreboard",
      ),
      selectedOverlayIds: [],
    });
  },
  setSelectedOverlayIds: (ids) => set({ selectedOverlayIds: ids }),
  clearOverlaySelection: () => set({ selectedOverlayIds: [] }),
  bringSelectionForward: () =>
    set((state) => {
      const movableIds = state.selectedOverlayIds.filter((id) => {
        const overlay = state.overlays.find((entry) => entry.id === id);
        return overlay && !overlay.locked;
      });
      const next = shiftOverlayOrder(state.overlays, movableIds, "forward");
      return next === state.overlays ? {} : { overlays: next };
    }),
  sendSelectionBackward: () =>
    set((state) => {
      const movableIds = state.selectedOverlayIds.filter((id) => {
        const overlay = state.overlays.find((entry) => entry.id === id);
        return overlay && !overlay.locked;
      });
      const next = shiftOverlayOrder(state.overlays, movableIds, "backward");
      return next === state.overlays ? {} : { overlays: next };
    }),
  setVideoTrackKeyframes: (kfs) => set({ videoTrackKeyframes: kfs }),
  addVideoTrackKeyframe: (kf) =>
    set((state) => {
      const idx = state.videoTrackKeyframes.findIndex(
        (k) => Math.abs(k.time - kf.time) < 0.001,
      );
      if (idx >= 0) {
        const next = [...state.videoTrackKeyframes];
        next[idx] = { ...next[idx], ...kf };
        return { videoTrackKeyframes: next };
      }
      return {
        videoTrackKeyframes: [...state.videoTrackKeyframes, kf],
      };
    }),
  toggleScoreboardOverlay: (visible) => set({ showScoreboardOverlay: visible }),
}));
