/**
 * Tracks every <video> currently in the document and keeps our volume/mute
 * preference applied to it.
 *
 * Instagram re-mutes and re-creates video elements constantly (virtualised feed,
 * React re-renders), so preferences have to be re-asserted on the media events
 * rather than set once at attach time.
 */

import { prefs } from "./prefs";
import { isEnabledHere } from "./surface";

const videos = new Set<HTMLVideoElement>();
const listeners = new WeakMap<HTMLVideoElement, AbortController>();
/**
 * The values we last wrote and how many volumechange events they will produce,
 * so we can recognise our own. The count matters: changing volume and muted in
 * one call queues two events, and a single-slot record consumed the first and
 * mistook the second for Instagram.
 */
const written = new WeakMap<HTMLVideoElement, { volume: number; muted: boolean; pending: number }>();
/** Guards against a ping-pong war if Instagram insists on re-muting. */
const reasserts = new WeakMap<HTMLVideoElement, number>();
const replayTimers = new WeakMap<HTMLVideoElement, number>();
/** Same scheme as `written`, for playbackRate. */
const wroteRate = new WeakMap<HTMLVideoElement, number>();
const rateReasserts = new WeakMap<HTMLVideoElement, number>();
const MAX_REASSERTS = 3;

/** The video the control bar is pointing at — the only one allowed to make sound. */
let active: HTMLVideoElement | null = null;
/**
 * While our own controls are driving a video, ignore changes we cannot account
 * for instead of fighting them. Dragging the volume slider queues a burst of
 * writes, and an event from an earlier write arriving after a later one has
 * been recorded would otherwise read as the page interfering.
 *
 * This can only ever delay a correction — never record a preference — which is
 * the difference between it and the intent window it replaced.
 */
const driving = new WeakMap<HTMLVideoElement, number>();
const DRIVING_MS = 400;

function isDriving(video: HTMLVideoElement): boolean {
  return performance.now() < (driving.get(video) ?? 0);
}

export function getVideos(): ReadonlySet<HTMLVideoElement> {
  return videos;
}

/**
 * Change volume/mute on behalf of the user. The ONLY way a preference is written.
 *
 * Two time-windowed schemes were tried before this and both persisted the
 * page's changes as the user's: `userActivation.isActive` (true for ~5s after
 * any gesture anywhere) and a 500ms per-video window (a reset landing inside it
 * still counted). A window cannot distinguish "the user did this" from
 * "something else did this very soon after" — only knowing which call site made
 * the change can, so preferences are written here and nowhere else.
 *
 * The cost is that Instagram's own mute button no longer updates the
 * preference; it is treated as the page interfering and put back. For a tool
 * whose entire purpose is that your setting survives Instagram resetting it,
 * that is the right way round.
 */
export function setVolume(video: HTMLVideoElement, volume: number, muted: boolean): void {
  driving.set(video, performance.now() + DRIVING_MS);
  const volumeChanges = Math.abs(video.volume - volume) >= 0.001;
  const muteChanges = video.muted !== muted;
  if (volumeChanges || muteChanges) {
    written.set(video, { volume, muted, pending: (volumeChanges ? 1 : 0) + (muteChanges ? 1 : 0) });
    if (volumeChanges) video.volume = volume;
    if (muteChanges) video.muted = muted;
  }
  prefs.update({ volume, muted });
}

/** Change playback speed on behalf of the user. See setVolume. */
export function setSpeed(video: HTMLVideoElement, rate: number): void {
  driving.set(video, performance.now() + DRIVING_MS);
  if (Math.abs(video.playbackRate - rate) >= 0.001) {
    wroteRate.set(video, rate);
    video.playbackRate = rate;
  }
  prefs.update({ speed: rate });
}

export function setActiveVideo(video: HTMLVideoElement | null): void {
  if (active === video) return;
  active = video;
  // The old active video has to be re-muted and the new one un-muted.
  for (const v of videos) applyPrefs(v);
}

export function scan(): void {
  for (const video of document.querySelectorAll("video")) {
    if (!videos.has(video)) adopt(video);
  }
  for (const video of videos) {
    if (!video.isConnected) forget(video);
  }
}

function adopt(video: HTMLVideoElement): void {
  const ac = new AbortController();
  const opts = { signal: ac.signal };
  listeners.set(video, ac);
  videos.add(video);

  video.addEventListener("loadedmetadata", () => {
    // A fresh load is a new fight, not a continuation of the old one.
    reasserts.delete(video);
    rateReasserts.delete(video);
    applyPrefs(video);
    applyRate(video);
  }, opts);

  video.addEventListener("play", () => {
    reasserts.delete(video);
    rateReasserts.delete(video);
    applyPrefs(video);
    applyRate(video);
    // Instagram sometimes mutes a beat after playback starts.
    clearTimeout(replayTimers.get(video));
    replayTimers.set(video, window.setTimeout(() => {
      applyPrefs(video);
      applyRate(video);
    }, 200));
  }, opts);

  video.addEventListener("volumechange", () => onVolumeChange(video), opts);
  video.addEventListener("ratechange", () => onRateChange(video), opts);

  applyPrefs(video);
  applyRate(video);
}

function forget(video: HTMLVideoElement): void {
  listeners.get(video)?.abort();
  listeners.delete(video);
  clearTimeout(replayTimers.get(video));
  replayTimers.delete(video);
  videos.delete(video);
  if (active === video) active = null;
}

function applyPrefs(video: HTMLVideoElement): void {
  // The bar is off on this surface, so our preferences have no business
  // unmuting anything here either.
  if (!isEnabledHere()) return;

  const { volume, muted } = prefs.current;
  // Unmuting without a user gesture makes Chrome's autoplay policy stop the
  // video, so only restore an unmuted state once the tab has been interacted with.
  const mayUnmute = navigator.userActivation?.hasBeenActive ?? false;
  // Only the video the bar is on may play sound: Instagram autoplays several
  // posts at once as they enter the viewport, and unmuting all of them means
  // three soundtracks at the same time.
  const targetMuted = muted || video !== active ? true : mayUnmute ? false : video.muted;

  const volumeChanges = Math.abs(video.volume - volume) >= 0.001;
  const muteChanges = video.muted !== targetMuted;
  if (!volumeChanges && !muteChanges) return;

  // One event per property, so record how many to expect back.
  written.set(video, {
    volume,
    muted: targetMuted,
    pending: (volumeChanges ? 1 : 0) + (muteChanges ? 1 : 0),
  });
  if (volumeChanges) video.volume = volume;
  if (muteChanges) video.muted = targetMuted;
}

/**
 * Playback speed applies to every video, not just the active one.
 *
 * Unlike volume there is nothing to collide with — two videos at 1.5x is
 * exactly what "I set 1.5x" should mean — and no autoplay policy to satisfy,
 * so no user-activation gate is needed.
 */
function applyRate(video: HTMLVideoElement): void {
  if (!isEnabledHere()) return;
  const { speed } = prefs.current;
  if (Math.abs(video.playbackRate - speed) < 0.001) return;
  wroteRate.set(video, speed);
  video.playbackRate = speed;
}

function onRateChange(video: HTMLVideoElement): void {
  const ours = wroteRate.get(video);
  if (ours !== undefined && Math.abs(video.playbackRate - ours) < 0.001) {
    wroteRate.delete(video);
    return;
  }
  if (isDriving(video)) return;
  const count = rateReasserts.get(video) ?? 0;
  if (count >= MAX_REASSERTS) return;
  rateReasserts.set(video, count + 1);
  applyRate(video);
}

function onVolumeChange(video: HTMLVideoElement): void {
  // Our own write coming back to us. Matching on the exact values rather than a
  // flag released on a timer, because volumechange is a media-element task and
  // a timer is a different task source with no defined ordering between them.
  const ours = written.get(video);
  if (ours && Math.abs(video.volume - ours.volume) < 0.001 && video.muted === ours.muted) {
    if (--ours.pending <= 0) written.delete(video);
    return;
  }

  if (isDriving(video)) return;

  const count = reasserts.get(video) ?? 0;
  if (count >= MAX_REASSERTS) return;
  reasserts.set(video, count + 1);
  applyPrefs(video);
}
