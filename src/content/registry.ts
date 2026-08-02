/**
 * Tracks every <video> currently in the document and keeps our volume/mute
 * preference applied to it.
 *
 * Instagram re-mutes and re-creates video elements constantly (virtualised feed,
 * React re-renders), so preferences have to be re-asserted on the media events
 * rather than set once at attach time.
 */

import { prefs } from "./prefs";

const videos = new Set<HTMLVideoElement>();
const listeners = new WeakMap<HTMLVideoElement, AbortController>();
/** Set while we are the ones writing to .volume/.muted, to ignore our own events. */
const applying = new WeakSet<HTMLVideoElement>();
/** Guards against a ping-pong war if Instagram insists on re-muting. */
const reasserts = new WeakMap<HTMLVideoElement, number>();
const MAX_REASSERTS = 3;

export function getVideos(): ReadonlySet<HTMLVideoElement> {
  return videos;
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

  video.addEventListener("loadedmetadata", () => applyPrefs(video), opts);
  video.addEventListener("play", () => {
    applyPrefs(video);
    // Instagram sometimes mutes a beat after playback starts.
    window.setTimeout(() => applyPrefs(video), 200);
  }, opts);
  video.addEventListener("volumechange", () => onVolumeChange(video), opts);

  applyPrefs(video);
}

function forget(video: HTMLVideoElement): void {
  listeners.get(video)?.abort();
  listeners.delete(video);
  videos.delete(video);
}

function applyPrefs(video: HTMLVideoElement): void {
  const { volume, muted } = prefs.current;
  // Unmuting without a user gesture makes Chrome's autoplay policy stop the
  // video, so only restore an unmuted state once the tab has been interacted with.
  const mayUnmute = navigator.userActivation?.hasBeenActive ?? false;
  const targetMuted = muted ? true : mayUnmute ? false : video.muted;

  if (Math.abs(video.volume - volume) < 0.001 && video.muted === targetMuted) return;

  applying.add(video);
  if (Math.abs(video.volume - volume) >= 0.001) video.volume = volume;
  if (video.muted !== targetMuted) video.muted = targetMuted;
  window.setTimeout(() => applying.delete(video), 0);
}

function onVolumeChange(video: HTMLVideoElement): void {
  if (applying.has(video)) return;

  // A recent user gesture means a human moved it — either our bar or Instagram's
  // own mute button. Either way, that is the new preference.
  if (navigator.userActivation?.isActive) {
    prefs.update({ volume: video.volume, muted: video.muted });
    reasserts.delete(video);
    return;
  }

  const count = reasserts.get(video) ?? 0;
  if (count >= MAX_REASSERTS) return;
  reasserts.set(video, count + 1);
  applyPrefs(video);
}
