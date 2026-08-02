/**
 * The control bar. One shared instance that re-targets to whichever video the
 * pointer is over — you only ever interact with one at a time, and a singleton
 * is far cheaper than a bar per video in a virtualised feed.
 *
 * The host element lives at document.body level and is positioned over the
 * video from its bounding rect. Two reasons:
 *   - React never owns it, so re-renders cannot rip it out;
 *   - our events start outside React's root container, so clicks on the bar can
 *     never reach Instagram's play/pause and mute handlers.
 * The exception is fullscreen, where the host is moved into the fullscreen
 * element (nothing outside it renders) and switched to absolute positioning.
 * That does put it inside Instagram's tree, so the mount is re-checked each
 * frame rather than only on attach.
 */

import { ICONS } from "./icons";
import { BAR_CSS } from "./styles";
import { fullscreenVideo, releaseIfInactive, toggleFullscreen } from "./fullscreen";
import { setSpeed, setVolume } from "./registry";
import { SPEEDS } from "./prefs";

const HOST_TAG = "igvc-overlay";
const Z_INDEX = 2147483000;
const MIN_VISIBLE_WIDTH = 80;
/** Fallback if the bar has not been laid out yet. */
const ASSUMED_BAR_HEIGHT = 92;

const BASE_HOST_CSS = [
  "display:block",
  "position:fixed",
  "margin:0",
  "padding:0",
  "border:0",
  "pointer-events:none",
  "visibility:hidden",
  `z-index:${Z_INDEX}`,
].join(" !important;") + " !important;";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * How long the video is, as far as seeking is concerned.
 *
 * Instagram serves MSE/blob-backed video, where duration is NaN until metadata
 * lands and Infinity for anything live. Falling back to the seekable range keeps
 * the scrubber usable instead of showing a dead 0:00.
 */
function usableDuration(video: HTMLVideoElement): number {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  const seekable = video.seekable;
  if (seekable && seekable.length > 0) {
    const end = seekable.end(seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return 0;
}

/** 1 -> "1x", 1.5 -> "1.5x", 0.25 -> "0.25x". */
function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

function ratioFrom(event: PointerEvent, track: HTMLElement): number {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

const TEMPLATE = `
<div class="root">
  <div class="surface"></div>
  <div class="wrap" part="wrap">
  <div class="seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
    <div class="track">
      <div class="buffered"></div>
      <div class="fill"></div>
      <div class="thumb"></div>
    </div>
  </div>
  <div class="row">
    <button class="btn play" type="button" aria-label="Play"></button>
    <div class="vol">
      <button class="btn mute" type="button" aria-label="Mute"></button>
      <div class="volslider" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
        <div class="vtrack">
          <div class="vfill"></div>
          <div class="vthumb"></div>
        </div>
      </div>
    </div>
    <span class="time"><span class="cur">0:00</span> / <span class="dur">0:00</span></span>
      <span class="spacer"></span>
      <div class="speed">
        <div class="ratemenu" role="menu" hidden></div>
        <button class="btn rate" type="button" aria-label="Playback speed" aria-haspopup="true" aria-expanded="false">1x</button>
      </div>
      <button class="btn fs" type="button" aria-label="Fullscreen"></button>
    </div>
  </div>
</div>`;

interface Painted {
  paused: boolean | null;
  current: string;
  duration: string;
  progress: number;
  buffered: number;
  volume: number;
  muted: boolean | null;
  fullscreen: boolean | null;
  seekable: boolean | null;
  rate: number;
}

const BLANK: Painted = {
  paused: null,
  current: "",
  duration: "",
  progress: -1,
  buffered: -1,
  volume: -1,
  muted: null,
  fullscreen: null,
  seekable: null,
  rate: -1,
};

class ControlBar {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly root: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly seek: HTMLElement;
  private readonly seekTrack: HTMLElement;
  private readonly seekBuffered: HTMLElement;
  private readonly seekFill: HTMLElement;
  private readonly seekThumb: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly fsBtn: HTMLButtonElement;
  private readonly rateBtn: HTMLButtonElement;
  private readonly rateMenu: HTMLElement;
  private readonly volSlider: HTMLElement;
  private readonly volTrack: HTMLElement;
  private readonly volFill: HTMLElement;
  private readonly volThumb: HTMLElement;
  private readonly curEl: HTMLElement;
  private readonly durEl: HTMLElement;

  video: HTMLVideoElement | null = null;
  private visible = false;
  private inFullscreen = false;
  private dragging: { kind: "seek" | "volume"; pointerId: number } | null = null;
  private raf = 0;
  private painted: Painted = { ...BLANK };

  constructor() {
    this.host = document.createElement(HOST_TAG);
    this.host.style.cssText = BASE_HOST_CSS;
    this.shadow = this.host.attachShadow({ mode: "open" });

    // Constructable stylesheets rather than a <style> tag: never touches the
    // page's style-src CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(BAR_CSS);
    this.shadow.adoptedStyleSheets = [sheet];
    this.shadow.innerHTML = TEMPLATE;

    const q = <T extends HTMLElement>(sel: string): T => {
      const el = this.shadow.querySelector<T>(sel);
      if (!el) throw new Error(`igvc: missing ${sel}`);
      return el;
    };

    this.root = q(".root");
    this.surface = q(".surface");
    this.wrap = q(".wrap");
    this.seek = q(".seek");
    this.seekTrack = q(".seek .track");
    this.seekBuffered = q(".seek .buffered");
    this.seekFill = q(".seek .fill");
    this.seekThumb = q(".seek .thumb");
    this.playBtn = q<HTMLButtonElement>(".play");
    this.muteBtn = q<HTMLButtonElement>(".mute");
    this.fsBtn = q<HTMLButtonElement>(".fs");
    this.rateBtn = q<HTMLButtonElement>(".rate");
    this.rateMenu = q(".ratemenu");
    this.volSlider = q(".volslider");
    this.volTrack = q(".vtrack");
    this.volFill = q(".vfill");
    this.volThumb = q(".vthumb");
    this.curEl = q(".cur");
    this.durEl = q(".dur");

    this.wireEvents();
  }

  get isInteracting(): boolean {
    return this.dragging !== null;
  }

  // ---------------------------------------------------------------- lifecycle

  attachTo(video: HTMLVideoElement): void {
    if (this.video !== video) {
      this.video = video;
      this.painted = { ...BLANK };
    }
    this.ensureMounted();
    this.start();
  }

  detach(): void {
    this.video = null;
    this.dragging = null;
    this.hide();
    this.stop();
  }

  show(): void {
    if (!this.visible) {
      this.visible = true;
      this.wrap.classList.add("on");
      this.host.style.setProperty("visibility", "visible", "important");
    }
    // The loop parks itself while hidden, so showing has to wake it.
    this.start();
  }

  hide(): void {
    if (this.dragging) return;
    if (!this.visible) return;
    this.visible = false;
    this.closeRateMenu();
    this.wrap.classList.remove("on");
    this.host.style.setProperty("visibility", "hidden", "important");
  }

  private start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** In fullscreen the host lives inside Instagram's tree, where React may
   *  remove it, so the mount is re-checked rather than assumed. */
  private ensureMounted(): void {
    const target = (this.inFullscreen ? document.fullscreenElement : null) ?? document.body;
    if (this.host.parentNode !== target) target.appendChild(this.host);
  }

  // ------------------------------------------------------------- render loop

  private tick = (): void => {
    const video = this.video;
    if (!video) {
      this.raf = 0;
      return;
    }
    if (!video.isConnected) {
      this.detach();
      return;
    }
    // Park the loop when there is nothing to draw. Without this, one hover
    // leaves a forced layout flush running every frame for the life of the page.
    if (!this.visible && !this.dragging) {
      this.raf = 0;
      return;
    }

    this.ensureMounted();
    if (!this.inFullscreen && !this.syncRect(video)) {
      // hide() refuses to act mid-drag, so parking here would freeze the bar
      // on screen with evaluateHover declining to restart it.
      this.raf = this.dragging ? requestAnimationFrame(this.tick) : 0;
      return;
    }
    this.syncState(video);
    this.raf = requestAnimationFrame(this.tick);
  };

  /**
   * Follows the video's on-screen box, clamped to the viewport.
   *
   * Clamping matters: the bar sits at the bottom of the host, so on a short
   * window a tall feed video whose bottom is below the fold would render its
   * controls entirely off-screen, and hovering it would appear to do nothing.
   *
   * Returns false when there is nowhere sensible to draw.
   */
  private syncRect(video: HTMLVideoElement): boolean {
    const r = video.getBoundingClientRect();
    // clientWidth/clientHeight, not innerWidth/innerHeight: the latter include
    // the scrollbar, and Instagram always has one.
    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;
    const left = Math.max(0, Math.round(r.left));
    const top = Math.max(0, Math.round(r.top));
    const right = Math.min(viewW, Math.round(r.right));
    const bottom = Math.min(viewH, Math.round(r.bottom));
    const width = right - left;
    const height = bottom - top;

    // The bar is anchored to the bottom of the host, so if the visible slice of
    // the video is shorter than the bar, the bar would render *above* the video
    // — over the previous post — and swallow clicks there at z-index 2147483000.
    const needed = this.wrap.offsetHeight || ASSUMED_BAR_HEIGHT;
    if (width < MIN_VISIBLE_WIDTH || height < needed) {
      this.hide();
      return false;
    }

    const s = this.host.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("left", `${left}px`, "important");
    s.setProperty("top", `${top}px`, "important");
    // Derived from the rounded edges, so the bar cannot end up a hairline
    // wider or narrower than the video at fractional zoom levels.
    s.setProperty("width", `${width}px`, "important");
    s.setProperty("height", `${height}px`, "important");
    return true;
  }

  private syncState(video: HTMLVideoElement): void {
    const p = this.painted;

    if (p.paused !== video.paused) {
      p.paused = video.paused;
      this.playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause;
      this.playBtn.setAttribute("aria-label", video.paused ? "Play" : "Pause");
    }

    const duration = usableDuration(video);
    const seekable = duration > 0;
    if (p.seekable !== seekable) {
      p.seekable = seekable;
      this.seek.classList.toggle("disabled", !seekable);
      this.seek.setAttribute("aria-disabled", String(!seekable));
    }

    const progress = seekable ? video.currentTime / duration : 0;
    if (this.dragging?.kind !== "seek" && Math.abs(progress - p.progress) > 0.0005) {
      p.progress = progress;
      this.paintSeek(progress);
      this.seek.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
      this.seek.setAttribute("aria-valuetext", `${formatTime(video.currentTime)} of ${formatTime(duration)}`);
    }

    const current = formatTime(video.currentTime);
    if (current !== p.current) {
      p.current = current;
      this.curEl.textContent = current;
    }
    const dur = seekable ? formatTime(duration) : "--:--";
    if (dur !== p.duration) {
      p.duration = dur;
      this.durEl.textContent = dur;
    }

    const buffered =
      seekable && video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) / duration : 0;
    if (Math.abs(buffered - p.buffered) > 0.002) {
      p.buffered = buffered;
      this.seekBuffered.style.width = `${Math.min(100, buffered * 100)}%`;
    }

    const effectiveVolume = video.muted ? 0 : video.volume;
    if (p.muted !== video.muted || Math.abs(effectiveVolume - p.volume) > 0.002) {
      p.muted = video.muted;
      p.volume = effectiveVolume;
      this.muteBtn.innerHTML =
        effectiveVolume === 0 ? ICONS.volumeMuted : effectiveVolume < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh;
      this.muteBtn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
      this.volFill.style.width = `${effectiveVolume * 100}%`;
      this.volThumb.style.left = `${effectiveVolume * 100}%`;
      this.volSlider.setAttribute("aria-valuenow", String(Math.round(effectiveVolume * 100)));
      this.volSlider.setAttribute("aria-valuetext", video.muted ? "muted" : `${Math.round(effectiveVolume * 100)}%`);
    }

    if (Math.abs(video.playbackRate - p.rate) > 0.001) {
      p.rate = video.playbackRate;
      this.rateBtn.textContent = formatRate(video.playbackRate);
      this.rateBtn.setAttribute("aria-label", `Playback speed, ${formatRate(video.playbackRate)}`);
      for (const item of this.rateMenu.children) {
        const on = Math.abs(Number((item as HTMLElement).dataset.rate) - video.playbackRate) < 0.001;
        item.classList.toggle("on", on);
        item.setAttribute("aria-checked", String(on));
      }
    }

    if (p.fullscreen !== this.inFullscreen) {
      p.fullscreen = this.inFullscreen;
      this.fsBtn.innerHTML = this.inFullscreen ? ICONS.exitFullscreen : ICONS.enterFullscreen;
      this.fsBtn.setAttribute("aria-label", this.inFullscreen ? "Exit fullscreen" : "Fullscreen");
    }
  }

  private bindSliderKeys(
    surface: HTMLElement,
    apply: (video: HTMLVideoElement, direction: number, toEnd: boolean) => void,
  ): void {
    surface.addEventListener("keydown", (e) => {
      const video = this.video;
      if (!video) return;
      let direction = 0;
      let toEnd = false;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") direction = 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") direction = -1;
      else if (e.key === "Home") { direction = -1; toEnd = true; }
      else if (e.key === "End") { direction = 1; toEnd = true; }
      else return;
      e.preventDefault();
      apply(video, direction, toEnd);
    });
  }

  private speedWrap(): HTMLElement {
    return this.rateBtn.parentElement as HTMLElement;
  }

  private buildRateMenu(): void {
    for (const rate of SPEEDS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "rateitem";
      item.dataset.rate = String(rate);
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", "false");
      item.textContent = formatRate(rate);
      item.addEventListener("click", () => {
        const video = this.video;
        this.closeRateMenu();
        if (!video) return;
        setSpeed(video, rate);
      });
      this.rateMenu.appendChild(item);
    }
  }

  private toggleRateMenu(): void {
    this.rateMenu.hidden ? this.openRateMenu() : this.closeRateMenu();
  }

  private openRateMenu(): void {
    this.rateMenu.hidden = false;
    this.rateBtn.setAttribute("aria-expanded", "true");
  }

  private closeRateMenu(): void {
    if (this.rateMenu.hidden) return;
    this.rateMenu.hidden = true;
    this.rateBtn.setAttribute("aria-expanded", "false");
  }

  private togglePlayback(): void {
    const video = this.video;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }

  private paintSeek(ratio: number): void {
    const pct = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    this.seekFill.style.width = pct;
    this.seekThumb.style.left = pct;
  }

  // ----------------------------------------------------------------- events

  private wireEvents(): void {
    // Instagram listens on document for its own play/pause and mute toggles.
    // Bubble phase, deliberately: a capture-phase stopPropagation() here would
    // fire before the event reached our own buttons and kill every control.
    //
    // preventDefault as well as stopPropagation, because they solve different
    // problems. Outside fullscreen the host hangs off document.body and stopping
    // propagation is enough. In fullscreen the host is moved inside the
    // fullscreen element — which on Instagram sits inside the post's
    // <a href="/reel/...">. An ancestor anchor's default action does not care
    // that propagation stopped, so every click still navigated away.
    const stopAndPrevent = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick"] as const;
    for (const type of stopAndPrevent) {
      this.root.addEventListener(type, (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
    }
    // Stopped but never prevented: preventing wheel would trap the feed's
    // scroll whenever the pointer happened to be over the bar, and preventing
    // keys could swallow Escape on the way out of fullscreen.
    for (const type of ["wheel", "keydown", "keyup"] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }

    // In fullscreen the surface covers the screen, so this is "click the
    // picture to pause" — what every other player does, and what Instagram's
    // own click-catcher would otherwise turn into a navigation.
    this.surface.addEventListener("click", () => this.togglePlayback());

    this.playBtn.addEventListener("click", () => this.togglePlayback());

    this.muteBtn.addEventListener("click", () => {
      const video = this.video;
      if (!video) return;
      const volume = video.muted && video.volume === 0 ? 0.5 : video.volume;
      setVolume(video, volume, !video.muted);
    });

    this.fsBtn.addEventListener("click", () => {
      if (this.video) void toggleFullscreen(this.video);
    });

    this.bindSlider(this.seek, this.seekTrack, "seek", (ratio) => {
      const video = this.video;
      if (!video) return;
      const duration = usableDuration(video);
      if (duration <= 0) return;
      this.paintSeek(ratio);
      video.currentTime = ratio * duration;
    });

    this.bindSlider(this.volSlider, this.volTrack, "volume", (ratio) => {
      const video = this.video;
      if (!video) return;
      setVolume(video, ratio, ratio === 0);
    });

    this.bindSliderKeys(this.seek, (video, dir, toEnd) => {
      const duration = usableDuration(video);
      if (duration <= 0) return;
      video.currentTime = toEnd
        ? (dir > 0 ? duration : 0)
        : Math.min(duration, Math.max(0, video.currentTime + dir * 5));
    });
    this.bindSliderKeys(this.volSlider, (video, dir, toEnd) => {
      const next = toEnd ? (dir > 0 ? 1 : 0) : Math.min(1, Math.max(0, video.volume + dir * 0.05));
      setVolume(video, next, next === 0);
    });

    this.buildRateMenu();
    this.rateBtn.addEventListener("click", () => this.toggleRateMenu());
    // Any other interaction with the bar dismisses it, which is what a menu that
    // overlaps the controls has to do to stay out of the way.
    this.wrap.addEventListener("pointerdown", (e) => {
      if (!e.composedPath().includes(this.speedWrap())) this.closeRateMenu();
    });
    this.root.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape" && !this.rateMenu.hidden) {
        this.closeRateMenu();
        this.rateBtn.focus();
      }
    });

    document.addEventListener("fullscreenchange", this.onFullscreenChange);
  }

  private bindSlider(
    surface: HTMLElement,
    track: HTMLElement,
    kind: "seek" | "volume",
    apply: (ratio: number) => void,
  ): void {
    surface.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = { kind, pointerId: e.pointerId };
      surface.classList.add("dragging");
      surface.setPointerCapture(e.pointerId);
      apply(ratioFrom(e, track));
    });

    surface.addEventListener("pointermove", (e) => {
      if (this.dragging?.kind !== kind || this.dragging.pointerId !== e.pointerId) return;
      e.preventDefault();
      apply(ratioFrom(e, track));
    });

    // Always release this surface, whichever slider currently owns `dragging`.
    // With two pointers down, keying the cleanup off the shared field left a
    // slider stuck in .dragging and isInteracting permanently true, which froze
    // the bar on one video for the rest of the session.
    const end = (e: PointerEvent) => {
      surface.classList.remove("dragging");
      if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
      if (this.dragging?.pointerId === e.pointerId) this.dragging = null;
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
  }

  private onFullscreenChange = (): void => {
    const fsElement = document.fullscreenElement as HTMLElement | null;
    // Ask fullscreen.ts which video it put up, not this.video: the transition
    // takes hundreds of milliseconds, and a React re-render in that window can
    // detach the bar and null this.video, which used to leave the bar mounted
    // outside the fullscreen element where nothing renders.
    const fsVideo = fullscreenVideo();
    // fsElement !== fsVideo matters because contains() is reflexive: on the
    // fallback path that fullscreens the <video> itself, the bar would be
    // appended inside a <video>, where children never render.
    const owned = !!(fsElement && fsVideo && fsElement !== fsVideo && fsElement.contains(fsVideo));

    if (owned && fsElement && fsVideo) {
      this.inFullscreen = true;
      this.host.classList.add("fs");
      this.attachTo(fsVideo);
      const s = this.host.style;
      s.setProperty("position", "absolute", "important");
      for (const side of ["left", "top", "right", "bottom"] as const) {
        s.setProperty(side, "0", "important");
      }
      s.setProperty("width", "auto", "important");
      s.setProperty("height", "auto", "important");
      this.show();
      return;
    }

    this.inFullscreen = false;
    this.host.classList.remove("fs");
    for (const side of ["right", "bottom"] as const) this.host.style.removeProperty(side);
    this.host.style.setProperty("position", "fixed", "important");
    this.ensureMounted();
    // Unconditional: fullscreen can pass straight from our wrapper to another
    // element, and a `if (!document.fullscreenElement)` guard would leave our
    // attributes on Instagram's DOM for good.
    releaseIfInactive();
  };
}

export const bar = new ControlBar();
