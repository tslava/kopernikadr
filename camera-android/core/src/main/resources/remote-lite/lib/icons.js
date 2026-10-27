// Inline SVG icons (24×24, stroke = currentColor). Decorative: the button around them carries the
// accessible name.

const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  play: '<path d="M7.5 4.8v14.4L19.5 12z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  ghost: '<path d="M5 20.5V11a7 7 0 0114 0v9.5l-2.33-1.6-2.34 1.6L12 18.9l-2.33 1.6-2.34-1.6z"/><circle cx="9.5" cy="11" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="11" r="1.3" fill="currentColor" stroke="none"/>',
  film: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18M3 15h18M7.5 4.5V9M12 4.5V9M16.5 4.5V9M7.5 15v4.5M12 15v4.5M16.5 15v4.5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  watch: '<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9v6l5-3z" fill="currentColor"/>',
  wifi: '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1.3" fill="currentColor" stroke="none"/>',
  wifiOff: '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1.3" fill="currentColor" stroke="none"/><path d="M3 3l18 18" stroke-width="2.6"/>',
  busy: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 017.6-1.8"/>',
  warn: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="1" fill="currentColor" stroke="none"/>',
  dash: '<path d="M6 12h12"/>',
  rotate: '<path d="M20 12a8 8 0 11-2.34-5.66M20 4v5h-5"/>',
  soundOn: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>',
  soundOff: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  turtle: '<path d="M3.5 16.5a8.5 7 0 0117 0z"/><circle cx="21.3" cy="14" r="1.7"/><path d="M6.5 16.5v2.5M17.5 16.5v2.5M8 16.5l2-4.5h4l2 4.5"/>',
  hare: '<ellipse cx="10" cy="15.5" rx="6.5" ry="4.5"/><circle cx="16.8" cy="10.8" r="2.8"/><path d="M15.6 8.2L13.8 2.8M18.2 8.4l1.3-5.2M3.5 15.5H2.5M13 20h3"/>',
  battery: '',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] ?? ''}</svg>`;
}

/** Battery outline filled to `pct`; a bolt when charging. */
export function batteryIcon(pct, charging) {
  const w = Math.max(0, Math.min(14, Math.round((14 * (pct ?? 0)) / 100)));
  const bolt = charging ? '<path d="M12 7.5l-3 5h3l-1 4 3.5-5.5h-3z" fill="#141518" stroke="#141518" stroke-width=".6"/>' : '';
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<rect x="1.5" y="7" width="19" height="10" rx="2.2"/><path d="M22.5 10.5v3"/>`
    + `<rect x="4" y="9.5" width="${w}" height="5" rx=".8" fill="currentColor" stroke="none"/>${bolt}</svg>`;
}

/** The app mark (docs/icon/logo.svg): viewfinder corners, the sun, Earth with onion-skin ghosts. */
export const LOGO = `<svg class="logo" aria-hidden="true" viewBox="18 18 72 72"><defs><linearGradient id="kl-cg" gradientUnits="userSpaceOnUse" x1="15" y1="15" x2="85" y2="85"><stop offset="0" stop-color="#ff6b6b"/><stop offset="1" stop-color="#ffa94d"/></linearGradient><radialGradient id="kl-sun" gradientUnits="userSpaceOnUse" cx="52.34" cy="51.52" r="9.939"><stop offset="0" stop-color="#fffbe0"/><stop offset=".4" stop-color="#ffe066"/><stop offset="1" stop-color="#ffd43b"/></radialGradient><radialGradient id="kl-earth" gradientUnits="userSpaceOnUse" cx="43.61" cy="38.43" r="5.384"><stop offset="0" stop-color="#a5d8ff"/><stop offset=".55" stop-color="#4dabf7"/><stop offset="1" stop-color="#1c7ed6"/></radialGradient></defs><rect x="18" y="18" width="72" height="72" rx="16" fill="#2d1b3d"/><g transform="translate(18.300000000000004 18.300000000000004) scale(0.714)"><path d="M15,28 V20 Q15,15 20,15 H28" fill="none" stroke="url(#kl-cg)" stroke-width="5.0" stroke-linecap="round" stroke-linejoin="round"/><path d="M72,15 H80 Q85,15 85,20 V28" fill="none" stroke="url(#kl-cg)" stroke-width="5.0" stroke-linecap="round" stroke-linejoin="round"/><path d="M85,72 V80 Q85,85 80,85 H72" fill="none" stroke="url(#kl-cg)" stroke-width="5.0" stroke-linecap="round" stroke-linejoin="round"/><path d="M28,85 H20 Q15,85 15,80 V72" fill="none" stroke="url(#kl-cg)" stroke-width="5.0" stroke-linecap="round" stroke-linejoin="round"/></g><circle cx="76.78" cy="54.0" r="0.569" fill="#fff" opacity=".7"/><circle cx="76.39" cy="56.85" r="0.569" fill="#fff" opacity=".7"/><circle cx="75.24" cy="59.61" r="0.569" fill="#fff" opacity=".7"/><circle cx="73.37" cy="62.18" r="0.569" fill="#fff" opacity=".7"/><circle cx="70.83" cy="64.46" r="0.569" fill="#fff" opacity=".7"/><circle cx="67.73" cy="66.39" r="0.569" fill="#fff" opacity=".7"/><circle cx="64.15" cy="67.9" r="0.569" fill="#fff" opacity=".7"/><circle cx="60.23" cy="68.94" r="0.569" fill="#fff" opacity=".7"/><circle cx="56.1" cy="69.46" r="0.569" fill="#fff" opacity=".7"/><circle cx="51.9" cy="69.46" r="0.569" fill="#fff" opacity=".7"/><circle cx="47.77" cy="68.94" r="0.569" fill="#fff" opacity=".7"/><circle cx="43.85" cy="67.9" r="0.569" fill="#fff" opacity=".7"/><circle cx="40.27" cy="66.39" r="0.569" fill="#fff" opacity=".7"/><circle cx="37.17" cy="64.46" r="0.569" fill="#fff" opacity=".7"/><circle cx="34.63" cy="62.18" r="0.569" fill="#fff" opacity=".7"/><circle cx="32.76" cy="59.61" r="0.569" fill="#fff" opacity=".7"/><circle cx="31.61" cy="56.85" r="0.569" fill="#fff" opacity=".7"/><circle cx="31.22" cy="54.0" r="0.569" fill="#fff" opacity=".7"/><circle cx="31.61" cy="51.15" r="0.569" fill="#fff" opacity=".7"/><circle cx="32.76" cy="48.39" r="0.569" fill="#fff" opacity=".7"/><circle cx="34.63" cy="45.82" r="0.569" fill="#fff" opacity=".7"/><circle cx="37.17" cy="43.54" r="0.569" fill="#fff" opacity=".7"/><circle cx="40.27" cy="41.61" r="0.569" fill="#fff" opacity=".7"/><circle cx="43.85" cy="40.1" r="0.569" fill="#fff" opacity=".7"/><circle cx="47.77" cy="39.06" r="0.569" fill="#fff" opacity=".7"/><circle cx="51.9" cy="38.54" r="0.569" fill="#fff" opacity=".7"/><circle cx="56.1" cy="38.54" r="0.569" fill="#fff" opacity=".7"/><circle cx="60.23" cy="39.06" r="0.569" fill="#fff" opacity=".7"/><circle cx="64.15" cy="40.1" r="0.569" fill="#fff" opacity=".7"/><circle cx="67.73" cy="41.61" r="0.569" fill="#fff" opacity=".7"/><circle cx="70.83" cy="43.54" r="0.569" fill="#fff" opacity=".7"/><circle cx="73.37" cy="45.82" r="0.569" fill="#fff" opacity=".7"/><circle cx="75.24" cy="48.39" r="0.569" fill="#fff" opacity=".7"/><circle cx="76.39" cy="51.15" r="0.569" fill="#fff" opacity=".7"/><circle cx="54.0" cy="54.0" r="10.871" fill="#ffe066" opacity=".25"/><circle cx="54.0" cy="54.0" r="8.282" fill="url(#kl-sun)"/><circle cx="34.33" cy="47.79" r="3.727" fill="#4dabf7" opacity="0.3"/><circle cx="38.47" cy="42.61" r="3.727" fill="#4dabf7" opacity="0.55"/><circle cx="44.68" cy="39.51" r="4.141" fill="url(#kl-earth)"/><path d="M43.3,39.769 q0.863,-1.38 1.898,-0.518 q0.518,1.035 -0.345,1.553 z" fill="#69db7c" opacity=".9"/></svg>`;
