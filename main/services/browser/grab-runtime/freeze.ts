/** Pauses running CSS/WAAPI animations while grabbing hover/transition UI, restoring them on stop. */
export class AnimationFreezer {
  private paused: Animation[] = [];
  private frozen = false;

  isFrozen(): boolean {
    return this.frozen;
  }

  toggle(): boolean {
    if (this.frozen) {
      this.resume();
    } else {
      this.freeze();
    }
    return this.frozen;
  }

  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.paused = [];
    try {
      if (typeof document.getAnimations !== "function") return;
      for (const animation of document.getAnimations()) {
        if (animation.playState === "running") {
          try {
            animation.pause();
            this.paused.push(animation);
          } catch {
            // Ignore detached or finished animations.
          }
        }
      }
    } catch {
      // Ignore environments without Web Animations API.
    }
  }

  resume(): void {
    if (!this.frozen && this.paused.length === 0) return;
    this.frozen = false;
    const toRestore = this.paused;
    this.paused = [];
    for (const animation of toRestore) {
      try {
        animation.play();
      } catch {
        // Ignore animations whose targets were removed.
      }
    }
  }
}
