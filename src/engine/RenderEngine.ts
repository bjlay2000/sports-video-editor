import type {
  Overlay,
  Keyframe,
  ScoreEvent,
  VideoTrackKeyframe,
  ComputedOverlay,
  VideoTransform,
  ScoreboardState,
  RenderFrameState,
  TimelineModel,
} from "./types";

/* ---------- Interpolation ---------- */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolateKeyframes(
  base: {
    x: number;
    y: number;
    rotation?: number;
    opacity?: number;
    scale?: number;
  },
  keyframes: Keyframe[],
  time: number,
): {
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  scale: number;
} {
  const defaults = {
    x: base.x,
    y: base.y,
    rotation: base.rotation ?? 0,
    opacity: base.opacity ?? 1,
    scale: base.scale ?? 1,
  };

  if (keyframes.length === 0) return defaults;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  if (time <= sorted[0].time) return defaults;

  const last = sorted[sorted.length - 1];
  if (time >= last.time) {
    return {
      x: last.x ?? base.x,
      y: last.y ?? base.y,
      rotation: last.rotation ?? defaults.rotation,
      opacity: last.opacity ?? defaults.opacity,
      scale: last.scale ?? defaults.scale,
    };
  }

  let prev = sorted[0];
  let next = sorted[1];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time >= time) {
      prev = sorted[i - 1];
      next = sorted[i];
      break;
    }
  }

  const range = next.time - prev.time;
  const t = range > 0 ? (time - prev.time) / range : 0;

  return {
    x: lerp(prev.x ?? base.x, next.x ?? base.x, t),
    y: lerp(prev.y ?? base.y, next.y ?? base.y, t),
    rotation: lerp(
      prev.rotation ?? defaults.rotation,
      next.rotation ?? defaults.rotation,
      t,
    ),
    opacity: lerp(
      prev.opacity ?? defaults.opacity,
      next.opacity ?? defaults.opacity,
      t,
    ),
    scale: lerp(
      prev.scale ?? defaults.scale,
      next.scale ?? defaults.scale,
      t,
    ),
  };
}

/* ---------- Single overlay ---------- */

export function computeOverlay(
  overlay: Overlay,
  time: number,
): ComputedOverlay | null {
  if (time < overlay.startTime || time > overlay.endTime) return null;
  if (!overlay.visible) return null;

  const interp = interpolateKeyframes(overlay.base, overlay.keyframes, time);

  return {
    id: overlay.id,
    type: overlay.type,
    zIndex: overlay.zIndex,
    x: interp.x,
    y: interp.y,
    width: overlay.base.width * interp.scale,
    height: overlay.base.height * interp.scale,
    rotation: interp.rotation,
    opacity: interp.opacity,
    scale: interp.scale,
    text: overlay.text,
    fontFamily: overlay.fontFamily,
    fontSize: overlay.fontSize,
    color: overlay.color,
    imageSrc: overlay.imageSrc,
    visible: true,
    locked: overlay.locked,
    dynamic: overlay.dynamic,
  };
}

/* ---------- Scoreboard ---------- */

export function computeScoreboard(
  scoreEvents: ScoreEvent[],
  time: number,
): ScoreboardState {
  let home = 0;
  let away = 0;

  for (const event of scoreEvents) {
    if (event.time > time + 0.0001) continue;
    if (event.team === "home") {
      home += event.delta;
    } else {
      away += event.delta;
    }
  }

  return { home: Math.max(0, home), away: Math.max(0, away) };
}

/* ---------- Video transform ---------- */

export function computeVideoTransform(
  keyframes: VideoTrackKeyframe[],
  time: number,
): VideoTransform {
  if (keyframes.length === 0) return { scale: 1, x: 0, y: 0 };

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  if (time <= sorted[0].time) {
    return {
      scale: sorted[0].scale ?? 1,
      x: sorted[0].x ?? 0,
      y: sorted[0].y ?? 0,
    };
  }

  const last = sorted[sorted.length - 1];
  if (time >= last.time) {
    return { scale: last.scale ?? 1, x: last.x ?? 0, y: last.y ?? 0 };
  }

  let prev = sorted[0];
  let next = sorted[1];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time >= time) {
      prev = sorted[i - 1];
      next = sorted[i];
      break;
    }
  }

  const range = next.time - prev.time;
  const t = range > 0 ? (time - prev.time) / range : 0;

  return {
    scale: lerp(prev.scale ?? 1, next.scale ?? 1, t),
    x: lerp(prev.x ?? 0, next.x ?? 0, t),
    y: lerp(prev.y ?? 0, next.y ?? 0, t),
  };
}

/* ---------- Full render state ---------- */

export function getRenderState(
  model: TimelineModel,
  time: number,
): RenderFrameState {
  const visibleOverlays = model.overlays
    .map((overlay) => computeOverlay(overlay, time))
    .filter((o): o is ComputedOverlay => o !== null)
    .sort((a, b) => a.zIndex - b.zIndex);

  const scoreboard = computeScoreboard(model.scoreEvents, time);

  // Inject computed scores into scoreboard overlays
  for (const overlay of visibleOverlays) {
    if (overlay.dynamic?.type === "scoreboard") {
      if (overlay.id === "score-home") {
        overlay.text = String(scoreboard.home);
      } else if (overlay.id === "score-away") {
        overlay.text = String(scoreboard.away);
      }
    }
  }

  const videoTransform = computeVideoTransform(
    model.videoTrack.keyframes,
    time,
  );

  return { overlays: visibleOverlays, videoTransform, scoreboard };
}
