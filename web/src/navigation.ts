import type { Point } from './model';

export type RoadSnap = {
  point: Point;
  distanceMeters: number;
  segmentIndex: number;
  bearing: number;
};

// This is only a visual aid for an active planned route. Raw GPS is retained
// for recording; if the driver leaves the route, the arrow shows raw GPS.
export function snapToRoute(position: Point, route: Point[], maxDistanceMeters = 35): RoadSnap | null {
  if (route.length < 2) return null;
  const latitudeRadians = position[1] * Math.PI / 180;
  const metresPerLongitude = 111_320 * Math.cos(latitudeRadians);
  const metresPerLatitude = 110_540;
  let closest: RoadSnap | null = null;
  for (let index = 0; index < route.length - 1; index++) {
    const start = route[index];
    const end = route[index + 1];
    const dx = (end[0] - start[0]) * metresPerLongitude;
    const dy = (end[1] - start[1]) * metresPerLatitude;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 0.0001) continue;
    const px = (position[0] - start[0]) * metresPerLongitude;
    const py = (position[1] - start[1]) * metresPerLatitude;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
    const distanceMeters = Math.hypot(px - t * dx, py - t * dy);
    if (!closest || distanceMeters < closest.distanceMeters) {
      closest = {
        point: [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])],
        distanceMeters,
        segmentIndex: index,
        bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
      };
    }
  }
  return closest && closest.distanceMeters <= maxDistanceMeters ? closest : null;
}

export function traversedRoute(route: Point[], snap: RoadSnap | null): Point[] {
  return snap ? [...route.slice(0, snap.segmentIndex + 1), snap.point] : [];
}
