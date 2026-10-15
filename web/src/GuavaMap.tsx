import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { DrivingRoute, DrivePoint, MapView, Point, RoadScope, Trip } from './model';
import { ISRAEL_CENTER } from './model';
import { WEEK_DRIVER_IDS } from './game';

type TerritoryLayer = { color: string; lines: Point[][]; unitIds: string[]; stretchMeters: number[]; width: number };
export type TerritorySelection = { unitId: string; ownerId: string; stretchMeters: number };

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
  demoTerritory: Record<string, TerritoryLayer> | null;
  liveTerritory: Record<string, TerritoryLayer> | null;
  selectedTerritoryOwner: string | null;
  onTerritorySelect: (selection: TerritorySelection | null) => void;
  demoPulse: Array<{ color: string; lines: Point[][]; width: number }> | null;
  livePulse: Array<{ color: string; lines: Point[][]; width: number }> | null;
  demoLocation: Point | null;
  demoFocusCommand: number;
  liveFocusCommand: number;
};

const NORMAL_STYLE = 'https://tiles.openfreemap.org/styles/bright';
const QUIET_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SATELLITE_STYLE = import.meta.env.VITE_MAPTILER_KEY
  ? `https://api.maptiler.com/maps/hybrid/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`
  : null;
maplibregl.setWorkerUrl(workerUrl);

function lineData(lines: Point[][], properties?: (index: number) => Record<string, string>) {
  return {
    type: 'FeatureCollection',
    features: lines.flatMap((line, index) => line.length > 1 ? [{
      type: 'Feature', properties: properties?.(index) || {}, geometry: { type: 'LineString', coordinates: line },
    }] : []),
  };
}

function ensureLine(map: maplibregl.Map, id: string, lines: Point[][], color: string, width: number, opacity: number, properties?: (index: number) => Record<string, string>) {
  const data = lineData(lines, properties);
  if (!map.getSource(id)) {
    map.addSource(id, { type: 'geojson', data: data as never });
    map.addLayer({
      id, type: 'line', source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity },
    });
  } else {
    (map.getSource(id) as maplibregl.GeoJSONSource).setData(data as never);
    map.setPaintProperty(id, 'line-color', color);
    map.setPaintProperty(id, 'line-width', width);
    map.setPaintProperty(id, 'line-opacity', opacity);
  }
}

function syncMap(map: maplibregl.Map, props: Props) {
  if (!map.isStyleLoaded()) return;
  // Bright's transit layer is unusually dense in Harish; show individual
  // stops only at street-level zoom while keeping main roads and place names.
  if (map.getLayer('poi_transit') && (props.view === 'Regular' || props.view === 'Altitude')) {
    map.setLayerZoomRange('poi_transit', 16, 24);
  }
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
  // Saved GPS is private. Territory paints only settled, public ownership.
  ensureLine(map, 'guava-territory', [], '#f18ca0', 9, 0.72);
  for (const id of WEEK_DRIVER_IDS) {
    const layer = props.demoTerritory?.[id];
    const selected = props.selectedTerritoryOwner;
    ensureLine(map, `guava-demo-${id}`, props.view === 'Territory' ? layer?.lines || [] : [], layer?.color || '#8b9699', selected === id ? 12 : layer?.width || 8, selected && selected !== id ? .3 : .92,
      index => ({ unitId: layer?.unitIds[index] || '', ownerId: id, stretchMeters: String(layer?.stretchMeters[index] || 0) }));
  }
  const liveIds = new Set(Object.keys(props.liveTerritory || {}).map(id => `guava-owned-${id}`));
  for (const layer of map.getStyle().layers.filter(item => item.id.startsWith('guava-owned-'))) {
    if (!liveIds.has(layer.id)) ensureLine(map, layer.id, [], '#8b9699', 9, 0);
  }
  for (const [id, layer] of Object.entries(props.liveTerritory || {})) {
    const selected = props.selectedTerritoryOwner;
    ensureLine(map, `guava-owned-${id}`, props.view === 'Territory' ? layer.lines : [], layer.color,
      selected === id ? 12 : layer.width, selected && selected !== id ? .3 : .92,
      index => ({ unitId: layer.unitIds[index] || '', ownerId: id, stretchMeters: String(layer.stretchMeters[index] || 0) }));
  }
  ensureLine(map, 'guava-live', props.view === 'Territory' ? [live] : [], '#e85d82', 10, 0.94);
  ensureLine(map, 'guava-road-pulse', props.view === 'Road Pulse' && props.roadScope === 'Mine' ? saved : [], '#d35377', 9, 0.22);
  for (let index = 0; index < 4; index++) {
    const layer = props.demoPulse?.[index] || props.livePulse?.[index];
    ensureLine(map, `guava-demo-pulse-${index}`, props.view === 'Road Pulse' && props.roadScope === 'Everybody' ? layer?.lines || [] : [], layer?.color || '#edc7c8', layer?.width || 6, .85);
  }
  ensureLine(map, 'guava-alternatives', props.routes.filter((_, index) => index !== props.selectedRoute).map(route => route.coordinates), '#919aa5', 5, 0.75);
  const selected = props.routes[props.selectedRoute];
  ensureLine(map, 'guava-route', selected ? [selected.coordinates] : [], '#ee668b', 7, 0.96);
}

export default function GuavaMap(props: Props) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const styleRef = useRef<'normal' | 'quiet' | 'satellite'>('normal');
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!nodeRef.current) return;
    const map = new maplibregl.Map({
      container: nodeRef.current,
      style: NORMAL_STYLE,
      center: ISRAEL_CENTER,
      zoom: 12,
      pitch: 0,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.on('style.load', () => syncMap(map, latest.current));
    map.on('click', event => {
      const current = latest.current;
      if (current.view !== 'Territory') return;
      const ids = (current.demoTerritory ? WEEK_DRIVER_IDS.map(id => `guava-demo-${id}`)
        : Object.keys(current.liveTerritory || {}).map(id => `guava-owned-${id}`)).filter(id => map.getLayer(id));
      if (!ids.length) return;
      const feature = map.queryRenderedFeatures(event.point, { layers: ids })[0]
        || map.queryRenderedFeatures([[event.point.x - 10, event.point.y - 10], [event.point.x + 10, event.point.y + 10]], { layers: ids })[0];
      const unitId = feature?.properties?.unitId;
      const ownerId = feature?.properties?.ownerId;
      const stretchMeters = Number(feature?.properties?.stretchMeters);
      current.onTerritorySelect(typeof unitId === 'string' && typeof ownerId === 'string' && Number.isFinite(stretchMeters) ? { unitId, ownerId, stretchMeters } : null);
    });
    mapRef.current = map;
    return () => { markerRef.current?.remove(); markerRef.current = null; map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targetStyle = props.view === 'Satellite' && SATELLITE_STYLE ? 'satellite'
      : props.view === 'Territory' || props.view === 'Road Pulse' ? 'quiet' : 'normal';
    if (styleRef.current !== targetStyle) {
      styleRef.current = targetStyle;
      map.setStyle(targetStyle === 'satellite' ? SATELLITE_STYLE! : targetStyle === 'quiet' ? QUIET_STYLE : NORMAL_STYLE);
      return;
    }
    syncMap(map, props);
  }, [props.view, props.roadScope, props.trips, props.livePoints, props.routes, props.selectedRoute, props.demoTerritory, props.liveTerritory, props.demoPulse, props.livePulse, props.selectedTerritoryOwner]);

  useEffect(() => {
    const map = mapRef.current;
    const shownPosition = props.demoLocation || props.position;
    if (!map || !shownPosition) return;
    if (!markerRef.current) {
      const marker = document.createElement('div');
      marker.className = 'position-arrow';
      marker.innerHTML = '<span></span>';
      markerRef.current = new maplibregl.Marker({ element: marker, rotationAlignment: 'map' }).setLngLat(shownPosition).addTo(map);
      // A browser fix can arrive after the map first renders; follow it once.
      map.easeTo({ center: shownPosition, zoom: 14.5, duration: 650 });
    }
    markerRef.current.setLngLat(shownPosition);
    markerRef.current.setRotation(props.demoLocation ? 0 : props.heading ?? 0);
    if (props.isDriving) {
      map.easeTo({ center: shownPosition, zoom: Math.max(15.5, map.getZoom()), bearing: props.northUp ? 0 : (props.heading ?? map.getBearing()), pitch: 0, duration: 550 });
    }
  }, [props.position, props.heading, props.isDriving, props.northUp, props.demoLocation]);

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
    if (props.demoLocation) {
      map.easeTo({ center: props.demoLocation, zoom: 14.4, pitch: 0, bearing: 0, duration: 600 });
      return;
    }
    const points = Object.values(props.demoTerritory).flatMap(layer => layer.lines).flat();
    if (!points.length) return;
    const bounds = points.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(points[0], points[0]));
    map.fitBounds(bounds, { padding: 55, duration: 600, maxZoom: 14 });
  }, [props.demoFocusCommand, props.demoTerritory, props.demoLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.liveTerritory || props.liveFocusCommand === 0) return;
    const layers = props.selectedTerritoryOwner && props.liveTerritory[props.selectedTerritoryOwner]
      ? [props.liveTerritory[props.selectedTerritoryOwner]] : Object.values(props.liveTerritory);
    const points = layers.flatMap(layer => layer.lines).flat();
    if (!points.length) return;
    const bounds = points.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(points[0], points[0]));
    map.fitBounds(bounds, { padding: 55, duration: 600, maxZoom: 15.5 });
  }, [props.liveFocusCommand]);

  return <div ref={nodeRef} className="map-canvas" aria-label="Interactive map" />;
}
