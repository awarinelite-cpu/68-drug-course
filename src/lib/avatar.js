// Generates a simple flat-icon avatar based on gender, with an initials-based
// fallback when gender isn't set. Used anywhere a nurse's profile picture is shown.

export function avatarSVG(gender, size = 56) {
  const g = (gender || '').trim().toLowerCase();

  if (g === 'male') {
    return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Male avatar">
      <circle cx="50" cy="50" r="50" fill="#2563eb"/>
      <circle cx="50" cy="40" r="17" fill="#fff"/>
      <path d="M33 40a17 17 0 0 1 34 0c0-3-2-14-17-14s-17 11-17 14z" fill="#1d4ed8"/>
      <path d="M50 60c-18 0-33 11-33 28v6h66v-6c0-17-15-28-33-28z" fill="#fff"/>
    </svg>`;
  }

  if (g === 'female') {
    return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Female avatar">
      <circle cx="50" cy="50" r="50" fill="#db2777"/>
      <path d="M50 21c-15 0-25 11-25 24 0 7 2 12 4 16-2 1-4 3-4 6h50c0-3-2-5-4-6 2-4 4-9 4-16 0-13-10-24-25-24z" fill="#fbcfe8"/>
      <circle cx="50" cy="41" r="16" fill="#fff"/>
      <path d="M50 61c-18 0-32 11-32 28v5h64v-5c0-17-14-28-32-28z" fill="#fff"/>
    </svg>`;
  }

  return null; // no gender on file — caller should fall back to initials
}

// Returns ready-to-insert HTML: the gendered SVG avatar if gender is known,
// otherwise a circular initials badge in the given background color.
export function avatarMarkup(profile, size = 56, fallbackColor = '#2563eb') {
  const svg = avatarSVG(profile && profile.gender, size);
  if (svg) return svg;
  const initial = ((profile && profile.name) || '?').trim().charAt(0).toUpperCase() || '?';
  const fontSize = Math.round(size * 0.4);
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${fallbackColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:bold;">${initial}</div>`;
}
