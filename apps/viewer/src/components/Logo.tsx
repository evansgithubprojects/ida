/**
 * Ida's mark: a leaf whose veins branch like an event chain, each branch ending in a node. Colours come from the
 * `.logo-*` classes, so the mark follows the theme.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        {/* Bioluminescent: cyan at the tip fading to sea-glass at the stem. */}
        <linearGradient id="ida-leaf" x1="0.3" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#7fe6ff" />
          <stop offset="1" stopColor="#4fe0c0" />
        </linearGradient>
      </defs>
      <path className="logo-leaf" d="M16 2.5C24.6 7.2 27.6 15.2 24.1 22.6 21.9 27.1 18.6 29.1 16 29.6 13.4 29.1 10.1 27.1 7.9 22.6 4.4 15.2 7.4 7.2 16 2.5Z" />
      <path className="logo-veins" d="M16 29.6V8.2M16 21.2 10.9 16.6M16 15.8l5.2-4.4M16 25l4.7-3.8" />
      <g className="logo-nodes">
        <circle cx="16" cy="8.2" r="1.9" />
        <circle cx="10.9" cy="16.6" r="1.9" />
        <circle cx="21.2" cy="11.4" r="1.9" />
        <circle cx="20.7" cy="21.2" r="1.9" />
      </g>
    </svg>
  );
}

/** The mark and the wordmark together, for headers. */
export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">Ida</span>
    </span>
  );
}
