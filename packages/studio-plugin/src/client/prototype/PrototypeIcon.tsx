const paths = {
    flow: 'M4 4h6v6H4z M14 14h6v6h-6z M7 10v7h7 M14 4h6v6h-6z M10 7h4',
    document: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    layout: 'M3 4h18v16H3z M3 9h18 M9 9v11', layers: 'm12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
    handoff: 'M4 4h9v16H4z M9 12h12 m-4-4 4 4-4 4', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
    link: 'm10 13 4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z',
    'panel-left': 'M3 4h18v16H3z M9 4v16 m6-11-3 3 3 3', files: 'M8 3h10v14H8z M5 7H3v14h11v-2',
    'chevron-right': 'm9 5 7 7-7 7', 'chevron-down': 'm5 9 7 7 7-7', 'chevron-up': 'm5 15 7-7 7 7',
    'arrow-up': 'M12 20V4 m-6 6 6-6 6 6', 'arrow-right': 'M4 12h16 m-6-6 6 6-6 6',
    check: 'm5 12 4 4L19 6', 'check-circle': 'M21 11v1a9 9 0 1 1-5.3-8.2 M8 11l4 4 9-10',
    square: 'M6 6h12v12H6z', play: 'm8 4 12 8-12 8z', eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    code: 'm8 5-7 7 7 7 M16 5l7 7-7 7 m-2-17-4 20', more: 'M5 11h.01 M12 11h.01 M19 11h.01 M5 12h.01 M12 12h.01 M19 12h.01',
    refresh: 'M20 7a9 9 0 1 0 1 8 M20 2v6h-6', diff: 'M4 3h7v18H4z M14 3h6v18h-6 M6 8h3 M16 8h2 M7.5 6.5v3 M16 15h2 M6 15h3',
    sliders: 'M4 5h16 M4 12h16 M4 19h16 M8 2v6 M16 9v6 M10 16v6', globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a17 17 0 0 0 0 18 17 17 0 0 0 0-18',
    monitor: 'M3 4h18v13H3z M8 21h8 M12 17v4', tablet: 'M5 2h14v20H5z M11 19h2', phone: 'M7 2h10v20H7z M11 19h2',
    maximize: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5', external: 'M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7',
    shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z m-4 10 3 3 5-6', clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 6v6l4 2',
    folder: 'M3 5h6l2 3h10v12H3z', lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4', edit: 'm15 3 6 6-12 12H3v-6z M12 6l6 6',
    search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 m-2 5 6 6', terminal: 'm4 6 5 6-5 6 M12 18h8', alert: 'm12 3 10 18H2z M12 9v5 M12 17v1',
    close: 'm6 6 12 12 M6 18 18 6', plus: 'M12 4v16 M4 12h16', package: 'm12 3 9 5v10l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v10 M7 5l10 5',
  } as const

/** Shared stroke icons from the approved prototype workbench design. */
export function PrototypeIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
