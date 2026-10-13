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
