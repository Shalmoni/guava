import type { CloudGame } from './cloud';

export function cloudRankings(game: CloudGame, metric: 'XP' | 'Distance' | 'Height' | 'Territory', me: string) {
  const scores = new Map(game.scores.map(score => [score.user_id, score]));
  return game.profiles.filter(profile => profile.community_opt_in).map(profile => {
    const score = scores.get(profile.user_id);
    return {
      id: profile.user_id,
      name: profile.user_id === me ? 'You' : profile.display_name,
      color: profile.user_id === me ? '#f18ca0' : '#484d53',
      value: metric === 'XP' ? score?.xp ?? 0 : metric === 'Distance' ? score?.distance_m ?? 0
        : metric === 'Height' ? score?.height_m ?? 0 : score?.territory_m ?? 0,
    };
  }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}
