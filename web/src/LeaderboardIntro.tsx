import { useEffect, useId, useRef } from 'react';
import { Clock3, Flag, Sparkles, Trophy, X } from 'lucide-react';
import './game-context.css';

type Props = {
  onClose: () => void;
};

export default function LeaderboardIntro({ onClose }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== 'Tab') return;
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
      const first = buttons?.[0];
      const last = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, []);

  return <div className="sheet-backdrop leaderboard-intro-backdrop" onClick={onClose}>
    <section ref={dialogRef} className="bottom-sheet leaderboard-intro" role="dialog" aria-modal="true"
      aria-labelledby={titleId} onClick={event => event.stopPropagation()}>
      <div className="sheet-header">
        <h2 id={titleId}>A little friendly competition</h2>
        <button ref={closeRef} onClick={onClose} aria-label="Close leaderboard guide"><X size={21} /></button>
      </div>
      <p>Keep tracking privately, or join community play in Settings for a friendly challenge.</p>
      <div className="leaderboard-guide">
        <div><Sparkles size={21} /><div><h3>XP & levels</h3><p>Saved drives earn XP for distance, height traveled and roads new to you. Every 500 XP adds a level.</p></div></div>
        <div><Trophy size={21} /><div><h3>Choose what to compare</h3><p>Switch between XP, distance, height traveled and captured territory. Only drives shared after joining count on the community board.</p></div></div>
        <div><Flag size={21} /><div><h3>Capture road sections</h3><p>The Territory map shows today’s live road contests and current owners. Each drive adds one vote per section per day; loops in one drive add no extra votes. Votes reset daily, so one visit can take a road from an inactive owner. Ties leave no owner; untouched roads keep theirs.</p></div></div>
        <div><Clock3 size={21} /><div><h3>Results the next morning</h3><p>Rounds close at midnight Israel time. Ownership becomes final around 09:05 the next morning, allowing time for uploads.</p></div></div>
      </div>
      <p className="leaderboard-guide-note">Play around your everyday journeys. Check scores and game controls after parking.</p>
      <button className="pink-button sheet-action" onClick={onClose}>Got it</button>
    </section>
  </div>;
}
