const PATHS = {
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  plug: 'M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4',
  wrench: 'M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 0-2-2z',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  play: 'M8 5l11 7-11 7z',
  restart: 'M6 5v14M18 5l-9 7 9 7z',
  repeat: 'M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3',
  pause: 'M8 5v14M16 5v14',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4',
  save: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  pencil: 'M4 20l1-5L16 4l4 4L9 19zM14 6l4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  minus: 'M5 12h14',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 4l16 16',
  trimStart: 'M7 4v16M11 12h9M16 7l5 5-5 5',
  trimEnd: 'M17 4v16M13 12H4M8 7l-5 5 5 5',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
} as const;
export type IconName = keyof typeof PATHS;

export default function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
