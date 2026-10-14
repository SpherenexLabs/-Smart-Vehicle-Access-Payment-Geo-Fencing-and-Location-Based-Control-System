import React from 'react';

const paths = {
  battery: <><rect x="6" y="4" width="12" height="18" rx="2"/><path d="M10 4V2h4v2"/><path d="M9 12h6v7H9z" fill="currentColor" stroke="none"/></>,
  home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v12h5v-7h4v7h5V9"/></>,
  cells: <><path d="M4 21V13h3v8M11 21V7h3v14M18 21V3h3v18"/></>,
  balance: <><path d="M12 3v17M6 21h12M4 7h16M5 7l-4 8h8L5 7Zm14 0-4 8h8l-4-8Z"/><path d="M1 15c1 5 7 5 8 0m6 0c1 5 7 5 8 0"/></>,
  shield: <><path d="m12 2 9 4v6c0 5-5 9-9 11-4-2-9-6-9-11V6l9-4Z"/><path d="m8 12 3 3 5-6"/></>,
  car: <><path d="m5 7 2-4h10l2 4 2 4v7H3v-7l2-4Z"/><path d="M5 7h14M6 18v3m12-3v3M6 12h2m8 0h2"/></>,
  report: <><path d="M5 2h10l4 4v16H5z"/><path d="M14 2v5h5M8 11h8M8 15h8M8 19h5"/></>,
  chart: <><path d="M3 3v18h18"/><path d="m6 15 4-5 4 3 6-8"/></>,
  heart: <path d="M20.8 4.6c-2.1-2.1-5.5-2.1-7.6 0L12 5.8l-1.2-1.2c-2.1-2.1-5.5-2.1-7.6 0s-2.1 5.5 0 7.6L12 21l8.8-8.8c2.1-2.1 2.1-5.5 0-7.6Z"/>,
  discharge: <><circle cx="12" cy="12" r="9"/><path d="m16 8-8 8m0-5v5h5"/></>,
  settings: <><path d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
  alert: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/></>,
  play: <path d="m7 4 14 8-14 8V4Z"/>,
  stop: <rect x="5" y="5" width="14" height="14" rx="1"/>,
  cycle: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/></>,
  download: <><path d="M12 2v13m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  menu: <path d="M3 5h18M3 12h18M3 19h18"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7V2Z"/>
};

export default function Icon({ name, size = 22, className = '' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={`icon ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.report}</svg>;
}
