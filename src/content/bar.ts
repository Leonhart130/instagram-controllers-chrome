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
 */

import { ICONS } from "./icons";
import { BAR_CSS } from "./styles";
import { toggleFullscreen, unmark } from "./fullscreen";

const HOST_TAG = "igvc-overlay";
const Z_INDEX = 2147483000;

const BASE_HOST_CSS = [
  "display:block",
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

function ratioFrom(event: PointerEvent, track: HTMLElement): number {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

const TEMPLATE = `
<div class="wrap" part="wrap">
  <div class="seek" role="slider" tabindex="-1" aria-label="Seek">
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
      <div class="volslider" role="slider" aria-label="Volume">
        <div class="vtrack">
          <div class="vfill"></div>
          <div class="vthumb"></div>
        </div>
      </div>
    </div>
    <span class="time"><span class="cur">0:00</span> / <span class="dur">0:00</span></span>
    <span class="spacer"></span>
    <button class="btn fs" type="button" aria-label="Fullscreen"></button>
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
}

class ControlBar {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly wrap: HTMLElement;
  private readonly seek: HTMLElement;
  private readonly seekTrack: HTMLElement;
  private readonly seekBuffered: HTMLElement;
  private readonly seekFill: HTMLElement;
  private readonly seekThumb: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly fsBtn: HTMLButtonElement;
  private readonly volSlider: HTMLElement;
  private readonly volTrack: HTMLElement;
  private readonly volFill: HTMLElement;
  private readonly volThumb: HTMLElement;
  private readonly curEl: HTMLElement;
  private readonly durEl: HTMLElement;

  video: HTMLVideoElement | null = null;
  private visible = false;
  private inFullscreen = false;
  private dragging: "seek" | "volume" | null = null;
  private raf = 0;
  private painted: Painted = {
    paused: null,
    current: "",
    duration: "",
    progress: -1,
    buffered: -1,
    volume: -1,
    muted: null,
    fullscreen: null,
  };

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

    this.wrap = q(".wrap");
    this.seek = q(".seek");
    this.seekTrack = q(".seek .track");
    this.seekBuffered = q(".seek .buffered");
    this.seekFill = q(".seek .fill");
    this.seekThumb = q(".seek .thumb");
    this.playBtn = q<HTMLButtonElement>(".play");
    this.muteBtn = q<HTMLButtonElement>(".mute");
    this.fsBtn = q<HTMLButtonElement>(".fs");
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
    if (this.video === video) return;
    this.video = video;
    this.painted = {
      paused: null,
      current: "",
      duration: "",
      progress: -1,
      buffered: -1,
      volume: -1,
      muted: null,
      fullscreen: null,
    };
    if (!this.host.isConnected) document.body.appendChild(this.host);
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  detach(): void {
    this.video = null;
    this.dragging = null;
    this.hide();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.wrap.classList.add("on");
    this.host.style.setProperty("visibility", "visible", "important");
  }

  hide(): void {
    if (this.dragging) return;
    if (!this.visible) return;
    this.visible = false;
    this.wrap.classList.remove("on");
    this.host.style.setProperty("visibility", "hidden", "important");
  }

  // ------------------------------------------------------------- render loop

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const video = this.video;
    if (!video) return;
    if (!video.isConnected) {
      this.detach();
      return;
    }
    if (!this.inFullscreen) this.syncRect(video);
    if (this.visible) this.syncState(video);
  };

  /** Follows the video's on-screen box. Runs every frame — scroll, resize and
   *  Instagram's own layout shifts all come for free. */
  private syncRect(video: HTMLVideoElement): void {
    const r = video.getBoundingClientRect();
    const offscreen =
      r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
    if (offscreen) {
      this.hide();
      return;
    }
    const s = this.host.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("left", `${Math.round(r.left)}px`, "important");
    s.setProperty("top", `${Math.round(r.top)}px`, "important");
    s.setProperty("width", `${Math.round(r.width)}px`, "important");
    s.setProperty("height", `${Math.round(r.height)}px`, "important");
  }

  private syncState(video: HTMLVideoElement): void {
    const p = this.painted;

    if (p.paused !== video.paused) {
      p.paused = video.paused;
      this.playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause;
      this.playBtn.setAttribute("aria-label", video.paused ? "Play" : "Pause");
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const progress = duration > 0 ? video.currentTime / duration : 0;

    if (this.dragging !== "seek" && Math.abs(progress - p.progress) > 0.0005) {
      p.progress = progress;
      this.paintSeek(progress);
    }

    const current = formatTime(video.currentTime);
    if (current !== p.current) {
      p.current = current;
      this.curEl.textContent = current;
    }
    const dur = formatTime(duration);
    if (dur !== p.duration) {
      p.duration = dur;
      this.durEl.textContent = dur;
    }

    const buffered = duration > 0 && video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) / duration : 0;
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
    }

    if (p.fullscreen !== this.inFullscreen) {
      p.fullscreen = this.inFullscreen;
      this.fsBtn.innerHTML = this.inFullscreen ? ICONS.exitFullscreen : ICONS.enterFullscreen;
      this.fsBtn.setAttribute("aria-label", this.inFullscreen ? "Exit fullscreen" : "Fullscreen");
    }
  }

  private paintSeek(ratio: number): void {
    const pct = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    this.seekFill.style.width = pct;
    this.seekThumb.style.left = pct;
  }

  // ----------------------------------------------------------------- events

  private wireEvents(): void {
    // Instagram listens on document for its own play/pause and mute toggles.
    // Our host sits outside React's root so nothing leaks, but stop it anyway.
    // Bubble phase, deliberately: a capture-phase stopPropagation() here would
    // fire before the event reached our own buttons and kill every control.
    for (const type of ["pointerdown", "mousedown", "click", "dblclick", "wheel"] as const) {
      this.wrap.addEventListener(type, (e) => e.stopPropagation());
    }

    this.playBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const video = this.video;
      if (!video) return;
      if (video.paused) void video.play().catch(() => {});
      else video.pause();
    });

    this.muteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const video = this.video;
      if (!video) return;
      if (video.muted && video.volume === 0) video.volume = 0.5;
      video.muted = !video.muted;
    });

    this.fsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (this.video) void toggleFullscreen(this.video);
    });

    this.bindSlider(this.seek, this.seekTrack, "seek", (ratio) => {
      const video = this.video;
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      this.paintSeek(ratio);
      video.currentTime = ratio * video.duration;
    });

    this.bindSlider(this.volSlider, this.volTrack, "volume", (ratio) => {
      const video = this.video;
      if (!video) return;
      video.volume = ratio;
      video.muted = ratio === 0;
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
      this.dragging = kind;
      surface.classList.add("dragging");
      surface.setPointerCapture(e.pointerId);
      apply(ratioFrom(e, track));
    });

    surface.addEventListener("pointermove", (e) => {
      if (this.dragging !== kind) return;
      e.preventDefault();
      apply(ratioFrom(e, track));
    });

    const end = (e: PointerEvent) => {
      if (this.dragging !== kind) return;
      this.dragging = null;
      surface.classList.remove("dragging");
      if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
  }

  private onFullscreenChange = (): void => {
    const fsElement = document.fullscreenElement as HTMLElement | null;
    const owned = !!(fsElement && this.video && fsElement.contains(this.video));

    if (owned && fsElement) {
      this.inFullscreen = true;
      this.host.classList.add("fs");
      fsElement.appendChild(this.host);
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
    if (this.host.parentElement !== document.body) document.body.appendChild(this.host);
    if (!document.fullscreenElement) unmark();
  };
}

export const bar = new ControlBar();
