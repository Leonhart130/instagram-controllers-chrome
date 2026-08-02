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
const MAX_REASSERTS = 3;

/** The video the control bar is pointing at — the only one allowed to make sound. */
let active: HTMLVideoElement | null = null;
/** Which video the user just acted on, and until when. */
let intent: { video: HTMLVideoElement; until: number } | null = null;

export function getVideos(): ReadonlySet<HTMLVideoElement> {
  return videos;
}

/**
 * Called by our own controls before they change volume or mute.
 *
 * navigator.userActivation.isActive cannot do this job: it stays true for ~5s
 * after *any* gesture anywhere on the page, so an automatic Instagram re-mute
 * that lands in that window would be recorded as the user's preference and
 * persisted.
 *
 * Scoped to the video the control acted on, for the same reason. A window that
 * is merely time-bounded is still global: click unmute on one post, and any
 * other video muted within the window — including by our own applyPrefs, which
 * mutes every non-active video — lands here and persists muted:true, undoing
 * the click a second later and surviving the reload.
 */
export function markUserIntent(video: HTMLVideoElement): void {
  intent = { video, until: performance.now() + 500 };
}

function hasUserIntent(video: HTMLVideoElement): boolean {
  return intent !== null && intent.video === video && performance.now() < intent.until;
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
    applyPrefs(video);
  }, opts);

  video.addEventListener("play", () => {
    reasserts.delete(video);
    applyPrefs(video);
    // Instagram sometimes mutes a beat after playback starts.
    clearTimeout(replayTimers.get(video));
    replayTimers.set(video, window.setTimeout(() => applyPrefs(video), 200));
  }, opts);

  video.addEventListener("volumechange", () => onVolumeChange(video), opts);

  applyPrefs(video);
}

function forget(video: HTMLVideoElement): void {
  listeners.get(video)?.abort();
  listeners.delete(video);
  clearTimeout(replayTimers.get(video));
  replayTimers.delete(video);
  videos.delete(video);
  if (active === video) active = null;
  if (intent?.video === video) intent = null;
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

function onVolumeChange(video: HTMLVideoElement): void {
  // Our own write coming back to us. Matching on the exact values rather than a
  // flag released on a timer, because volumechange is a media-element task and
  // a timer is a different task source with no defined ordering between them.
  const ours = written.get(video);
  if (ours && Math.abs(video.volume - ours.volume) < 0.001 && video.muted === ours.muted) {
    if (--ours.pending <= 0) written.delete(video);
    return;
  }

  if (hasUserIntent(video)) {
    prefs.update({ volume: video.volume, muted: video.muted });
    reasserts.delete(video);
    return;
  }

  const count = reasserts.get(video) ?? 0;
  if (count >= MAX_REASSERTS) return;
  reasserts.set(video, count + 1);
  applyPrefs(video);
}
