import assert from 'node:assert/strict';
import test from 'node:test';
import { roadPieces, WEEK_DRIVER_IDS } from './game.ts';
import { simulateWeek, weekLeaderboard, weekMapLayers } from './week.ts';

const roads = Array.from({ length: 10 }, (_, index) => roadPieces([
  [35.0435, 32.46096],
  [35.044 + index * .001, 32.463 + index * .001],
]));

test('week simulation settles seven daily rounds for ten participants', () => {
  const scene = simulateWeek(roads);
  assert.equal(scene.snapshots.length, 7);
  assert.ok(scene.snapshots[6].driveCount > 70);
  assert.equal(weekLeaderboard('XP', scene.snapshots[6]).length, WEEK_DRIVER_IDS.length);
  assert.ok(scene.snapshots[6].result.owners.size > 0);
});

test('week snapshots are immutable as later days add drives', () => {
  const scene = simulateWeek(roads);
  assert.ok(scene.snapshots[6].driveCount > scene.snapshots[0].driveCount);
  assert.ok(scene.snapshots[6].stats.you.xp > scene.snapshots[0].stats.you.xp);
  assert.ok(scene.snapshots[6].pulse.size >= scene.snapshots[0].pulse.size);
});

test('shared road-use mock hides roads with fewer than three distinct drivers', () => {
  const scene = simulateWeek(roads);
  const last = scene.snapshots[6];
  const layers = weekMapLayers(scene, last);
  const sharedLines = layers.pulse.reduce((sum, layer) => sum + layer.lines.length, 0);
  const eligibleLines = [...scene.linesByUnit].reduce((sum, [unitId, lines]) => sum + ((last.pulse.get(unitId)?.drivers.size || 0) >= 3 ? lines.length : 0), 0);
  assert.equal(sharedLines, eligibleLines);
});

test('week-end map has multiple owners and multiple road-use shades', () => {
  const scene = simulateWeek(roads);
  const layers = weekMapLayers(scene, scene.snapshots[6]);
  assert.ok(WEEK_DRIVER_IDS.filter(id => layers.territory[id].lines.length > 0).length >= 5);
  assert.ok(layers.pulse.filter(layer => layer.lines.length > 0).length >= 3);
  assert.equal(layers.territory.contested, undefined);
  for (const layer of Object.values(layers.territory)) {
    assert.equal(layer.lines.length, layer.unitIds.length);
    assert.equal(layer.lines.length, layer.stretchMeters.length);
    assert.ok(layer.stretchMeters.every(length => length > 0));
  }
});
