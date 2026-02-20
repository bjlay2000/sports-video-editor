export class VideoEngine {
  private videoElement: HTMLVideoElement | null = null;
  private animationFrameId: number | null = null;
  private onTimeUpdate: ((time: number) => void) | null = null;

  attach(element: HTMLVideoElement) {
    this.videoElement = element;
  }

  detach() {
    this.stopTracking();
    this.videoElement = null;
  }

  getElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  loadVideo(src: string) {
    if (!this.videoElement) return;
    this.videoElement.src = src;
    this.videoElement.load();
  }

  async play(): Promise<void> {
    if (!this.videoElement) return;
    const playResult = this.videoElement.play();
    this.startTracking();
    if (playResult && typeof playResult.then === "function") {
      await playResult;
    }
  }

  pause() {
    if (!this.videoElement) return;
    this.videoElement.pause();
    this.stopTracking();
  }

  async togglePlayPause(): Promise<void> {
    if (!this.videoElement) return;
    if (this.videoElement.paused) {
      await this.play();
    } else {
      this.pause();
    }
  }

  seek(time: number) {
    if (!this.videoElement) return;
    this.videoElement.currentTime = Math.max(
      0,
      Math.min(time, this.videoElement.duration || 0)
    );
  }

  stepForward() {
    if (!this.videoElement) return;
    this.videoElement.currentTime += 1 / 60;
  }

  stepBackward() {
    if (!this.videoElement) return;
    this.videoElement.currentTime = Math.max(0, this.videoElement.currentTime - 1 / 60);
  }

  getCurrentTime(): number {
    return this.videoElement?.currentTime ?? 0;
  }

  getDuration(): number {
    return this.videoElement?.duration ?? 0;
  }

  isPlaying(): boolean {
    return this.videoElement ? !this.videoElement.paused : false;
  }

  setOnTimeUpdate(callback: (time: number) => void) {
    this.onTimeUpdate = callback;
  }

  private startTracking() {
    const track = () => {
      if (this.videoElement && this.onTimeUpdate) {
        this.onTimeUpdate(this.videoElement.currentTime);
      }
      this.animationFrameId = requestAnimationFrame(track);
    };
    this.animationFrameId = requestAnimationFrame(track);
  }

  private stopTracking() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}

export const videoEngine = new VideoEngine();
