import { Flag, Route } from 'lucide-react';
import type { MapView } from './model';
import './game-context.css';

type Props = {
  view: MapView;
  isCommunity: boolean;
  isGuest: boolean;
  hasRoads: boolean;
  /** Saved drives still waiting to upload; this is not a count of captured roads. */
  pendingCount?: number;
  isLoading?: boolean;
  unavailable?: boolean;
  onOpenLeaderboard?: () => void;
};

export default function MapContext({
  view, isCommunity, isGuest, hasRoads, pendingCount = 0, isLoading = false, unavailable = false, onOpenLeaderboard,
}: Props) {
  if (view !== 'Territory' && view !== 'Road Pulse' && view !== 'My Roads') return null;
  const mine = view === 'My Roads';
  const title = view === 'Territory' ? 'Territory' : mine ? 'My Roads' : 'Community Road Pulse';
  let message = '';
  if (mine) message = hasRoads ? 'Your saved drives on this device. Route lines stay in this browser.' : 'Finish and save a drive to see your roads here.';
  else if (!isCommunity) message = isGuest ? 'Sign in with Google to join community play and see shared roads.' : 'Community play is off. Join in Settings to see shared roads.';
  else if (unavailable) message = hasRoads ? 'Showing the last available community roads. Trying to reconnect.' : 'Community roads are unavailable right now. Your local drive history is still available.';
  else if (isLoading) message = 'Loading community roads…';
  else if (!hasRoads) message = view === 'Territory'
    ? 'No captured roads yet. Ownership becomes final around 09:05 Israel time the next morning.'
    : 'Roads appear after at least three participating drivers have used them.';

  return <aside className="map-context" aria-label={`${title} information`}>
    <div className="map-context-heading">{view === 'Territory' ? <Flag size={16} /> : <Route size={16} />}<strong>{title}</strong></div>
    {message && <p>{message}</p>}
    {isCommunity && !isLoading && view === 'Territory' && hasRoads && <div className="territory-legend" aria-label="Pink: yours. Dark: other drivers. Outlined gray: contested.">
      <span><i className="legend-mine" />You</span>
      <span><i className="legend-others" />Others</span>
      <span><i className="legend-contested" />Contested</span>
    </div>}
    {isCommunity && !isLoading && view === 'Road Pulse' && !mine && <div className="pulse-legend">
      <div><span>Less use</span><i aria-hidden="true" /><span>More use</span></div>
      <small>Recorded use, not live traffic.</small>
    </div>}
    {!mine && isCommunity && pendingCount > 0 && <small className="map-pending">{pendingCount} saved {pendingCount === 1 ? 'drive is' : 'drives are'} waiting to share.</small>}
    {view === 'Territory' && onOpenLeaderboard && <button className="map-context-link" onClick={onOpenLeaderboard}>How it works</button>}
  </aside>;
}
