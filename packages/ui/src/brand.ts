/** Canonical geometry from the supplied institutional SVG; shared by React and PWA. */
export const brandPaths = [
  "M50 38 108 24 170 51 143 59 C132 51 118 46 103 43 C91 41 82 43 75 48 L74 56 Z",
  "M78 50 C94 43 119 47 140 59 L140 78 C124 70 110 65 99 64 H74 C74 58 75 53 78 50 Z",
  "M58 82 H94 V118 H58 Z",
  "M103 82 H139 V116 Z",
  "M58 127 H94 C94 143 85 154 75 159 C69 162 64 163 58 163 Z",
  "M157 56 H158 V79 H157 Z",
  "M157 84 C156.5 89 155.2 93 154 97 C154.6 100 160.4 100 161 97 C159.8 93 158.5 89 158 84 Z",
] as const;

export function brandSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="28" fill="#ffffff"/><g fill="#0E208E">${brandPaths.map((d) => `<path d="${d}"/>`).join("")}<circle cx="157.5" cy="81.5" r="2.8"/></g></svg>`;
}
