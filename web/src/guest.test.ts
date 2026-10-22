import assert from 'node:assert/strict';
import test from 'node:test';
import { enterGuest, guestIsActive, leaveGuest, savedGuestName, saveGuestName } from './guest';

test('guest identity stays local and can be resumed after exiting', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  assert.equal(enterGuest('  Roadie  ', storage), 'Roadie');
  assert.equal(savedGuestName(storage), 'Roadie');
  assert.equal(guestIsActive(storage), true);
  leaveGuest(storage);
  assert.equal(guestIsActive(storage), false);
  assert.equal(savedGuestName(storage), 'Roadie');
  assert.throws(() => saveGuestName('   ', storage), /Choose a username/);
});
