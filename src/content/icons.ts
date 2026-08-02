const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${body}</svg>`;

const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  play: svg('<path fill="currentColor" d="M8 5.14v13.72L19 12z"/>'),
  pause: svg('<path fill="currentColor" d="M6.5 5h3.5v14H6.5zM14 5h3.5v14H14z"/>'),
  volumeHigh: svg(
    '<path fill="currentColor" d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/>' +
      `<path ${stroke} d="M15.4 9.2a4 4 0 0 1 0 5.6"/>` +
      `<path ${stroke} d="M18 6.6a7.6 7.6 0 0 1 0 10.8"/>`,
  ),
  volumeLow: svg(
    '<path fill="currentColor" d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/>' +
      `<path ${stroke} d="M15.4 9.2a4 4 0 0 1 0 5.6"/>`,
  ),
  volumeMuted: svg(
    '<path fill="currentColor" d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/>' +
      `<path ${stroke} d="M16 9.5l5 5M21 9.5l-5 5"/>`,
  ),
  enterFullscreen: svg(`<path ${stroke} d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>`),
  exitFullscreen: svg(`<path ${stroke} d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>`),
};
