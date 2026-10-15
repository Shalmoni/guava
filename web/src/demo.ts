import type { Point } from './model';
import { roadPieces, type RoadPiece } from './game';

const DESTINATIONS: Point[] = [[35.0659, 32.5051], [35.014, 32.482]];
const START: Point = [35.0435, 32.46096];

export async function loadDemoRoads(): Promise<RoadPiece[][]> {
  return Promise.all(DESTINATIONS.map(async destination => {
    const url = `https://router.project-osrm.org/route/v1/driving/${START.join(',')};${destination.join(',')}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Demo road geometry is unavailable. Please retry.');
    const data = await response.json() as { routes?: Array<{ geometry?: { coordinates?: Point[] } }> };
    const coordinates = data.routes?.[0]?.geometry?.coordinates;
    if (!coordinates?.length) throw new Error('The demo could not load the roads.');
    return roadPieces(coordinates);
  }));
}

// Ten different commutes that crisscross Harish and nearby roads. The map
// geometry comes from OSRM, while every player/drive/score is simulated.
const WEEK_ENDPOINTS: Array<[Point, Point]> = [
  [[35.0435, 32.46096], [35.048, 32.475]],
  [[35.0435, 32.46096], [35.057, 32.466]],
  [[35.0435, 32.46096], [35.033, 32.465]],
  [[35.041, 32.466], [35.049, 32.468]],
  [[35.036, 32.463], [35.050, 32.470]],
  [[35.052, 32.453], [35.039, 32.472]],
  [[35.043, 32.469], [35.047, 32.463]],
  [[35.038, 32.471], [35.052, 32.464]],
  [[35.039, 32.459], [35.048, 32.473]],
  [[35.050, 32.460], [35.037, 32.468]],
];

export async function loadWeekRoads(): Promise<RoadPiece[][]> {
  return Promise.all(WEEK_ENDPOINTS.map(async ([start, end]) => {
    const url = `https://router.project-osrm.org/route/v1/driving/${start.join(',')};${end.join(',')}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Week scenario roads are unavailable. Please retry.');
    const data = await response.json() as { routes?: Array<{ geometry?: { coordinates?: Point[] } }> };
    const coordinates = data.routes?.[0]?.geometry?.coordinates;
    if (!coordinates || coordinates.length < 2) throw new Error('A week scenario route could not be loaded.');
    return roadPieces(coordinates);
  }));
}
