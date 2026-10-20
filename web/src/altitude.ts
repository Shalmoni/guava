export type TerrainSample = { grid: string; meters: number };

export function trustedGpsAltitude(meters: number | null, accuracy: number | null): number | null {
  return meters != null && Number.isFinite(meters)
    && accuracy != null && Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 50
    ? meters : null;
}

export function shownAltitude(gps: number | null, terrain: TerrainSample | null, currentGrid: string): number | null {
  return gps ?? (terrain?.grid === currentGrid ? terrain.meters : null);
}
