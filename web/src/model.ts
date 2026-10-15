export type Point = [number, number]; // longitude, latitude
export type MapView = 'Regular' | 'Satellite' | 'Territory' | 'Road Pulse' | 'Altitude';
export type RoadScope = 'Everybody' | 'Mine';

export interface DrivePoint {
  position: Point;
  altitude: number | null;
  timestamp: number;
}

export interface Trip {
  id: string;
  startedAt: number;
  endedAt: number;
  points: DrivePoint[];
  distanceMeters: number;
  heightMeters: number;
  newRoadUnits: number;
  xp: number;
  destination?: string;
  communityStatus?: 'pending' | 'uploaded';
}

export interface RouteStep {
  distance: number;
  name: string;
  instruction: string;
  maneuver: Point;
  type: string;
  modifier?: string;
}

export interface DrivingRoute {
  coordinates: Point[];
  distance: number;
  duration: number;
  steps: RouteStep[];
}

export const ISRAEL_CENTER: Point = [35.043, 32.461]; // Harish until browser location is available
export const STORAGE_KEY = 'guava.web.trips.v1';

export function loadTrips(): Trip[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as Trip[];
    return Array.isArray(parsed) ? parsed.filter(trip => Array.isArray(trip.points)) : [];
  } catch {
    return [];
  }
}

export function saveTrips(trips: Trip[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trips.slice(0, 100)));
}

export function distanceMeters(a: Point, b: Point): number {
  const earth = 6371000;
  const latA = a[1] * Math.PI / 180;
  const latB = b[1] * Math.PI / 180;
  const dLat = latB - latA;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A local progress proxy, not the multiplayer road-plus-hex ownership key.
export function roadUnit(point: Point): string {
  const x = 6378137 * point[0] * Math.PI / 180;
  const latitude = Math.max(-85, Math.min(85, point[1])) * Math.PI / 180;
  const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + latitude / 2));
  return `${Math.floor(x / 25)}:${Math.floor(y / 25)}`;
}

export function tripUnits(points: DrivePoint[]): Set<string> {
  const units = new Set<string>();
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1].position;
    const to = points[index].position;
    const steps = Math.min(100, Math.max(1, Math.ceil(distanceMeters(from, to) / 12.5)));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      units.add(roadUnit([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]));
    }
  }
  return units;
}

export function finishTrip(
  points: DrivePoint[],
  startedAt: number,
  distance: number,
  height: number,
  older: Trip[],
  destination?: string,
): Trip | null {
  if (distance < 50 || points.length < 2) return null;
  const previous = new Set(older.flatMap(trip => [...tripUnits(trip.points)]));
  const units = tripUnits(points);
  const newRoadUnits = [...units].filter(unit => !previous.has(unit)).length;
  return {
    id: crypto.randomUUID(), startedAt, endedAt: Date.now(), points,
    distanceMeters: distance, heightMeters: height, newRoadUnits,
    xp: 10 + Math.floor(distance / 1000 * 8) + Math.floor(height / 20) + newRoadUnits * 2,
    destination,
  };
}

export function fmtDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function fmtTime(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function fmtClock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function routeFromOSRM(data: unknown): DrivingRoute[] {
  const source = data as {
    code?: string;
    routes?: Array<{
      distance: number; duration: number;
      geometry: { coordinates: Point[] };
      legs: Array<{ steps: Array<{
        distance: number; name: string;
        maneuver: { location: Point; type: string; modifier?: string };
      }> }>;
    }>;
  };
  if (source.code !== 'Ok' || !source.routes?.length) throw new Error('No driving route was found.');
  return source.routes.map(route => ({
    coordinates: route.geometry.coordinates,
    distance: route.distance,
    duration: route.duration,
    steps: route.legs.flatMap(leg => leg.steps.map(step => ({
      distance: step.distance,
      name: step.name,
      maneuver: step.maneuver.location,
      type: step.maneuver.type,
      modifier: step.maneuver.modifier,
      instruction: step.maneuver.type === 'arrive' ? 'Arrive at destination'
        : step.maneuver.type === 'depart' ? `Head onto ${step.name || 'the road'}`
        : `${step.maneuver.type === 'turn' ? 'Turn' : 'Continue'} ${step.maneuver.modifier || ''}${step.name ? ` onto ${step.name}` : ''}`.trim(),
    }))),
  }));
}
