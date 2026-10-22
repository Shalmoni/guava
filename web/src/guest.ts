const NAME_KEY = 'guava.guest.name.v1';
const ACTIVE_KEY = 'guava.guest.active.v1';

export function savedGuestName(storage: Pick<Storage, 'getItem'> = localStorage): string {
  try { return storage.getItem(NAME_KEY)?.trim().slice(0, 32) || ''; }
  catch { return ''; }
}

export function guestIsActive(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try { return storage.getItem(ACTIVE_KEY) === '1' && Boolean(savedGuestName(storage)); }
  catch { return false; }
}

export function saveGuestName(name: string, storage: Pick<Storage, 'setItem'> = localStorage): string {
  const clean = name.trim();
  if (!clean || clean.length > 32) throw new Error('Choose a username between 1 and 32 characters.');
  storage.setItem(NAME_KEY, clean);
  return clean;
}

export function enterGuest(name: string, storage: Pick<Storage, 'setItem'> = localStorage): string {
  const clean = saveGuestName(name, storage);
  storage.setItem(ACTIVE_KEY, '1');
  return clean;
}

export function leaveGuest(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(ACTIVE_KEY);
}
