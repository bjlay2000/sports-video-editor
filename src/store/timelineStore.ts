import { create } from "zustand";

export interface TimelineThumbnail {
  time: number;
  src: string;
}

export interface TimelineSegment {
  id: string;
  start: number;
  end: number;
}

interface TimelineState {
  pixelsPerSecond: number;
  scrollX: number;
  scrollY: number;
  playheadTime: number;
  thumbnails: TimelineThumbnail[];
  waveformSrc: string | null;
  assetsLoading: boolean;
  thumbnailsGenerating: boolean;
  selectedMarkerIds: number[];
  segments: TimelineSegment[];
  removedSegmentsHistory: Array<{ segment: TimelineSegment; index: number }>;
  selectedSegmentId: string | null;
  _skipNextSegmentInit: boolean;
  setPixelsPerSecond: (pps: number) => void;
  setScrollX: (x: number) => void;
  setScrollY: (y: number) => void;
  setPlayheadTime: (time: number) => void;
  setTimelineAssets: (payload: {
    thumbnails: TimelineThumbnail[];
    waveformSrc: string | null;
  }) => void;
  setThumbnails: (thumbnails: TimelineThumbnail[]) => void;
  setAssetsLoading: (loading: boolean) => void;
  setThumbnailsGenerating: (generating: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setSelectedMarkerIds: (ids: number[]) => void;
  clearSelection: () => void;
  toggleMarkerSelection: (id: number, additive?: boolean) => void;
  initializeSegments: (duration: number) => void;
  splitSegment: (time: number) => void;
  removeSegment: (segmentId: string) => void;
  undoRemoveSegment: () => void;
  setSelectedSegmentId: (segmentId: string | null) => void;
  setSkipNextSegmentInit: (skip: boolean) => void;
}

const createSegmentId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `segment-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const createSegment = (start: number, end: number): TimelineSegment => ({
  id: createSegmentId(),
  start,
  end,
});

export const useTimelineStore = create<TimelineState>((set) => ({
  pixelsPerSecond: 20,
  scrollX: 0,
  scrollY: 0,
  playheadTime: 0,
  thumbnails: [],
  waveformSrc: null,
  assetsLoading: false,
  thumbnailsGenerating: false,
  selectedMarkerIds: [],
  segments: [],
  removedSegmentsHistory: [],
  selectedSegmentId: null,
  _skipNextSegmentInit: false,
  setPixelsPerSecond: (pps) => set({ pixelsPerSecond: Math.max(2, Math.min(200, pps)) }),
  setScrollX: (x) => set({ scrollX: Math.max(0, x) }),
  setScrollY: (y) => set({ scrollY: y }),
  setPlayheadTime: (time) => set({ playheadTime: time }),
  setTimelineAssets: ({ thumbnails, waveformSrc }) => set({ thumbnails, waveformSrc }),
  setThumbnails: (thumbnails) => set({ thumbnails }),
  setAssetsLoading: (loading) => set({ assetsLoading: loading }),
  setThumbnailsGenerating: (generating) => set({ thumbnailsGenerating: generating }),
  zoomIn: () =>
    set((state) => ({
      pixelsPerSecond: Math.min(400, state.pixelsPerSecond * 1.2),
    })),
  zoomOut: () =>
    set((state) => ({
      pixelsPerSecond: Math.max(2, state.pixelsPerSecond / 1.2),
    })),
  setSelectedMarkerIds: (ids) => set({ selectedMarkerIds: ids }),
  clearSelection: () => set({ selectedMarkerIds: [], selectedSegmentId: null }),
  toggleMarkerSelection: (id, additive = false) =>
    set((state) => {
      const alreadySelected = state.selectedMarkerIds.includes(id);
      if (additive) {
        return {
          selectedMarkerIds: alreadySelected
            ? state.selectedMarkerIds.filter((mId) => mId !== id)
            : [...state.selectedMarkerIds, id],
        };
      }
      return {
        selectedMarkerIds: alreadySelected ? [] : [id],
      };
    }),
  setSelectedSegmentId: (segmentId) => set({ selectedSegmentId: segmentId }),
  setSkipNextSegmentInit: (skip) => set({ _skipNextSegmentInit: skip }),
  initializeSegments: (duration) =>
    set(() => {
      if (duration <= 0) {
        return { segments: [], removedSegmentsHistory: [], selectedSegmentId: null };
      }
      return { segments: [createSegment(0, duration)], removedSegmentsHistory: [], selectedSegmentId: null };
    }),
  splitSegment: (time) =>
    set((state) => {
      if (!state.segments.length) {
        return state;
      }
      const epsilon = 0.05;
      const targetIndex = state.segments.findIndex(
        (segment) => time > segment.start + epsilon && time < segment.end - epsilon
      );
      if (targetIndex === -1) {
        return state;
      }
      const segment = state.segments[targetIndex];
      const clampedTime = Math.max(segment.start + epsilon, Math.min(segment.end - epsilon, time));
      const nextSegments = [...state.segments];
      const left = createSegment(segment.start, clampedTime);
      const right = createSegment(clampedTime, segment.end);
      nextSegments.splice(targetIndex, 1, left, right);
      const selectedSegmentId =
        state.selectedSegmentId === segment.id ? left.id : state.selectedSegmentId;
      return { segments: nextSegments, selectedSegmentId };
    }),
  removeSegment: (segmentId) =>
    set((state) => {
      if (state.segments.length <= 1) {
        return state;
      }
      const index = state.segments.findIndex((segment) => segment.id === segmentId);
      if (index < 0) {
        return state;
      }
      const filtered = state.segments.filter((segment) => segment.id !== segmentId);
      const selectedSegmentId =
        state.selectedSegmentId === segmentId ? null : state.selectedSegmentId;
      const removed = state.segments[index];
      return {
        segments: filtered,
        selectedSegmentId,
        removedSegmentsHistory: [...state.removedSegmentsHistory, { segment: removed, index }],
      };
    }),
  undoRemoveSegment: () =>
    set((state) => {
      const last = state.removedSegmentsHistory[state.removedSegmentsHistory.length - 1];
      if (!last) return state;
      const nextSegments = [...state.segments];
      const insertAt = Math.max(0, Math.min(last.index, nextSegments.length));
      nextSegments.splice(insertAt, 0, last.segment);
      return {
        segments: nextSegments,
        selectedSegmentId: last.segment.id,
        removedSegmentsHistory: state.removedSegmentsHistory.slice(0, -1),
      };
    }),
}));
