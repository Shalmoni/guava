// Nonessential preferences can be unavailable in restricted browser contexts.
// Drive storage uses a stricter API that reports failures to the player.
export function preference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function setPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Nonessential preference. */ }
}
