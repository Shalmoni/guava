import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { DrivingRoute, DrivePoint, MapView, Point, RoadScope, Trip } from './model';
import { ISRAEL_CENTER } from './model';
import type { DriverId } from './game';
import { DEMO_DRIVERS } from './game';

type Props = {
  view: MapView;
  roadScope: RoadScope;
  trips: Trip[];
  livePoints: DrivePoint[];
  routes: DrivingRoute[];
  selectedRoute: number;
  position: Point | null;
  heading: number | null;
  isDriving: boolean;
  northUp: boolean;
  zoomCommand: number;
  centerCommand: number;
  demoTerritory: Record<DriverId | 'contested', Point[][]> | null;
  demoFocusCommand: number;
};

const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SATELLITE_STYLE = import.meta.env.VITE_MAPTILER_KEY
  ? `https://api.maptiler.com/maps/hybrid/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`
  : null;
maplibregl.setWorkerUrl(workerUrl);

function lineData(lines: Point[][]) {
  return {
    type: 'FeatureCollection',
    features: lines.filter(line => line.length > 1).map(line => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line },
    })),
  };
}

function ensureLine(map: maplibregl.Map, id: string, lines: Point[][], color: string, width: number, opacity: number) {
  const data = lineData(lines);
  if (!map.getSource(id)) {
    map.addSource(id, { type: 'geojson', data: data as never });
    map.addLayer({
      id, type: 'line', source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity },
    });
  } else {
    (map.getSource(id) as maplibregl.GeoJSONSource).setData(data as never);
  }
}

function syncMap(map: maplibregl.Map, props: Props) {
  if (!map.isStyleLoaded()) return;
  if (props.view !== 'Altitude' && map.getLayer('guava-altitude')) {
    map.removeLayer('guava-altitude');
    map.removeSource('guava-dem');
  }
  if (props.view === 'Altitude' && !map.getSource('guava-dem')) {
    map.addSource('guava-dem', {
      type: 'raster-dem', tiles: [TERRAIN_TILES], tileSize: 256,
      encoding: 'terrarium', maxzoom: 15,
    });
    // Keep water and every road/label above the elevation tint so it remains a usable map.
    const firstWaterOrRoad = map.getStyle().layers.find(layer => layer.id === 'water')?.id
      || map.getStyle().layers.find(layer => layer.type === 'line')?.id;
    map.addLayer({
      id: 'guava-altitude', type: 'color-relief', source: 'guava-dem',
      paint: {
        'color-relief-color': [
          'interpolate', ['linear'], ['elevation'],
          -100, '#3c9d83', 0, '#5caf83', 50, '#83bc82', 100, '#a8c68c',
          150, '#c7cc8b', 220, '#ddd08a', 300, '#e2bc79', 450, '#cc9d68',
          650, '#a87f61', 900, '#876e61', 1400, '#ded8cf',
        ],
        'color-relief-opacity': 0.82,
      },
    }, firstWaterOrRoad);
  }
  const saved = props.trips.map(trip => trip.points.map(point => point.position));
  const live = props.livePoints.map(point => point.position);
  ensureLine(map, 'guava-territory', props.view === 'Territory' ? saved : [], '#f18ca0', 9, 0.72);
  for (const id of ['you', 'maya', 'noam', 'contested'] as const) {
    ensureLine(map, `guava-demo-${id}`, props.view === 'Territory' ? props.demoTerritory?.[id] || [] : [], id === 'contested' ? '#9ca7a9' : DEMO_DRIVERS[id].color, 10, .9);
  }
  ensureLine(map, 'guava-live', props.view === 'Territory' ? [live] : [], '#e85d82', 10, 0.94);
  ensureLine(map, 'guava-road-pulse', props.view === 'Road Pulse' && props.roadScope === 'Mine' ? saved : [], '#d35377', 9, 0.22);
  ensureLine(map, 'guava-alternatives', props.routes.filter((_, index) => index !== props.selectedRoute).map(route => route.coordinates), '#919aa5', 5, 0.75);
  const selected = props.routes[props.selectedRoute];
  ensureLine(map, 'guava-route', selected ? [selected.coordinates] : [], '#ee668b', 7, 0.96);
}

export default function GuavaMap(props: Props) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const styleRef = useRef<'road' | 'satellite'>('road');
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!nodeRef.current) return;
    const map = new maplibregl.Map({
      container: nodeRef.current,
      style: BASE_STYLE,
      center: ISRAEL_CENTER,
      zoom: 12,
      pitch: 0,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.on('style.load', () => syncMap(map, latest.current));
    mapRef.current = map;
    return () => { markerRef.current?.remove(); markerRef.current = null; map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targetStyle = props.view === 'Satellite' && SATELLITE_STYLE ? 'satellite' : 'road';
    if (styleRef.current !== targetStyle) {
      styleRef.current = targetStyle;
      map.setStyle(targetStyle === 'satellite' ? SATELLITE_STYLE! : BASE_STYLE);
      return;
    }
    syncMap(map, props);
  }, [props.view, props.roadScope, props.trips, props.livePoints, props.routes, props.selectedRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.position) return;
    if (!markerRef.current) {
      const marker = document.createElement('div');
      marker.className = 'position-arrow';
      marker.innerHTML = '<span></span>';
      markerRef.current = new maplibregl.Marker({ element: marker, rotationAlignment: 'map' }).setLngLat(props.position).addTo(map);
      // A browser fix can arrive after the map first renders; follow it once.
      map.easeTo({ center: props.position, zoom: 14.5, duration: 650 });
    }
    markerRef.current.setLngLat(props.position);
    markerRef.current.setRotation(props.heading ?? 0);
    if (props.isDriving) {
      map.easeTo({ center: props.position, zoom: Math.max(15.5, map.getZoom()), bearing: props.northUp ? 0 : (props.heading ?? map.getBearing()), pitch: 0, duration: 550 });
    }
  }, [props.position, props.heading, props.isDriving, props.northUp]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.routes.length) return;
    const selected = props.routes[props.selectedRoute];
    if (!selected) return;
    const bounds = selected.coordinates.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(selected.coordinates[0], selected.coordinates[0]));
    map.fitBounds(bounds, { padding: { top: 110, bottom: 250, left: 35, right: 35 }, maxZoom: 15.5, duration: 650 });
  }, [props.routes, props.selectedRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.zoomCommand === 0) return;
    if (props.zoomCommand > 0) map.zoomIn(); else map.zoomOut();
  }, [props.zoomCommand]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.centerCommand === 0 || !props.position) return;
    map.easeTo({ center: props.position, zoom: props.isDriving ? 16 : 14.5, bearing: props.northUp ? 0 : (props.heading ?? 0), pitch: 0, duration: 500 });
  }, [props.centerCommand]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.demoTerritory || props.demoFocusCommand === 0) return;
    const points = Object.values(props.demoTerritory).flat(2);
    if (!points.length) return;
    const bounds = points.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(points[0], points[0]));
    map.fitBounds(bounds, { padding: 55, duration: 600, maxZoom: 14 });
  }, [props.demoFocusCommand, props.demoTerritory]);

  return <div ref={nodeRef} className="map-canvas" aria-label="Interactive map" />;
}
