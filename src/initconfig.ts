export const STALL_TIMER_DEFAULT = 7;
export const STALL_TIMER_INACTIVE_FIRST_X_TURNS = 10;
export const stallTimerInfoVisible = false;

export const TURN_TIMER_INITIAL = 0; // "null" or "0" value turns the timer off
export const TURN_TIMER_WARNING = 59; 
export const TURN_TIMER_ADD = 15; // 15 seconds added per turn

export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 2.1;

export const MOVE_COMBINE_ATTACK_ONCE_ONLY = true;

export const BOARD_GAP = 10;
export const STARTING_RESERVES = 40;
export const INITIAL_LAYOUT = [
  { q: 0, r: 0, count: 6 },
  { q: 1, r: 0, count: 5 },
  { q: 1, r: -1, count: 5 },
  { q: 0, r: -1, count: 5 },
  { q: -1, r: 0, count: 5 },
  { q: -1, r: 1, count: 5 },
  { q: 0, r: 1, count: 5 },
];
