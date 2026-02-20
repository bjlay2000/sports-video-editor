/* ------------------------------------------------------------
 *  Timeline-aware data model for the NLE render pipeline.
 *  Both preview and export share these types.
 * ------------------------------------------------------------ */

/* ---------- Keyframe ---------- */

export interface Keyframe {
  time: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

/* ---------- Overlay ---------- */

export interface OverlayBase {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  scale?: number;
}

export type OverlayType = "text" | "image" | "scoreboard";

export interface Overlay {
  id: string;
  type: OverlayType;
  zIndex: number;

  startTime: number;
  endTime: number;

  base: OverlayBase;
  keyframes: Keyframe[];

  /* Rendering properties */
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  imageSrc?: string;
  visible: boolean;
  locked?: boolean;

  dynamic?: {
    type: "scoreboard" | "text";
  };
}

/* ---------- Score Events ---------- */

export interface ScoreEvent {
  time: number;
  team: "home" | "away";
  delta: number;
}

/* ---------- Video Track ---------- */

export interface VideoTrackKeyframe {
  time: number;
  scale?: number;
  x?: number;
  y?: number;
}

/* ---------- Timeline Model ---------- */

export interface TimelineModel {
  duration: number;
  currentTime: number;
  overlays: Overlay[];
  scoreEvents: ScoreEvent[];
  videoTrack: {
    keyframes: VideoTrackKeyframe[];
  };
}

/* ---------- Computed / Render Output ---------- */

export interface ComputedOverlay {
  id: string;
  type: OverlayType;
  zIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  scale: number;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  imageSrc?: string;
  visible: boolean;
  locked?: boolean;
  dynamic?: {
    type: "scoreboard" | "text";
  };
}

export interface VideoTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ScoreboardState {
  home: number;
  away: number;
}

export interface RenderFrameState {
  overlays: ComputedOverlay[];
  videoTransform: VideoTransform;
  scoreboard: ScoreboardState;
}
