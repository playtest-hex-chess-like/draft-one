import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useGesture } from '@use-gesture/react';
import { Undo, Check, Info, Coins, Zap, Crown, Eye, EyeOff, AlertTriangle, Skull } from 'lucide-react';
import { BOARD_GAP, INITIAL_LAYOUT, STARTING_RESERVES, STALL_TIMER_DEFAULT, stallTimerInfoVisible, stallTimerInactiveFirstXTurns, MIN_ZOOM, MAX_ZOOM } from './initconfig';

const PIECE_TYPES: Record<number, { name: string; move: number; rule: string }> = {
  1: { name: 'Scout', move: 5, rule: "Extends frontline +1 tile. Cannot use the salvage mechanic." },
  2: { name: 'Cavalry', move: 4, rule: "+1 Attack Power when attacking. Can move axially and diagonally (slipping between hexes)." },
  3: { name: 'Small Army', move: 3, rule: "Can attack forts with adjacent allied armies to ignore the -1 penalty. Independent salvage." },
  4: { name: 'Big Army', move: 2, rule: "Can attack forts with adjacent allied armies to ignore the -1 penalty. Independent salvage." },
  5: { name: 'Encampment', move: 0, rule: "Creates permanent Fort tile. On a Fort Tile, units other than the king and scout may spend one action to use the move/attack/combine actions with a portion of their stack." },
  6: { name: 'King', move: 0, rule: "This piece starts on a Fort tile. Move Speed is based on stack count. Inherits the coordinated strike and cavalry movement abilities at the appropriate stack counts." },
};

type Player = 1 | 2;
type Stack = { owner: Player; count: number; isKing?: boolean };

const HEX_SIZE = 40;

const axialToPixel = (q: number, r: number, s: number) => {
  const x = s * ((3 / 2) * q);
  const y = s * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r);
  return { x, y };
};

const pixelToAxial = (x: number, y: number, s: number) => {
  const q = ((2 / 3) * x) / s;
  const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / s;
  return { q, r };
};

const axialRound = (fracQ: number, fracR: number) => {
  let fracS = -fracQ - fracR;
  let q = Math.round(fracQ);
  let r = Math.round(fracR);
  let s = Math.round(fracS);

  const q_diff = Math.abs(q - fracQ);
  const r_diff = Math.abs(r - fracR);
  const s_diff = Math.abs(s - fracS);

  if (q_diff > r_diff && q_diff > s_diff) {
    q = -r - s;
  } else if (r_diff > s_diff) {
    r = -q - s;
  } else {
    s = -q - r;
  }
  return { q, r };
};

const getNeighbors = (q: number, r: number) => [
  { q: q + 1, r: r }, { q: q + 1, r: r - 1 }, { q: q, r: r - 1 },
  { q: q - 1, r: r }, { q: q - 1, r: r + 1 }, { q: q, r: r + 1 }
];

const getDiagonalNeighbors = (q: number, r: number) => [
  { q: q + 1, r: r - 2 }, { q: q + 2, r: r - 1 }, { q: q + 1, r: r + 1 },
  { q: q - 1, r: r + 2 }, { q: q - 2, r: r + 1 }, { q: q - 1, r: r - 1 }
];

const getDistance = (a: { q: number, r: number }, b: { q: number, r: number }) => {
  return (Math.abs(a.q - b.q) + 
          Math.abs(a.q + a.r - b.q - b.r) + 
          Math.abs(a.r - b.r)) / 2;
};

const getHexesInRadius = (center: { q: number, r: number }, radius: number) => {
  let results = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      results.push({ q: center.q + q, r: center.r + r });
    }
  }
  return results;
};

function getActiveFrontline(
  player: Player, 
  grid: Map<string, Stack>, 
  kingPos: { p1: { q: number, r: number } | null, p2: { q: number, r: number } | null }
): string[] {
  let king = player === 1 ? kingPos.p1 : kingPos.p2;
  if (!king) return [];

  let checkQueue = [king];
  let connectedAllies = new Set<string>();
  let finalAura = new Set<string>();

  while (checkQueue.length > 0) {
    let currentPos = checkQueue.shift()!;
    let currentKey = `${currentPos.q},${currentPos.r}`;

    if (connectedAllies.has(currentKey)) continue;
    connectedAllies.add(currentKey);

    let stack = grid.get(currentKey);
    if (!stack) continue;

    let auraRange = (stack.count === 1) ? 2 : 1; 

    let myAuraHexes = getHexesInRadius(currentPos, auraRange);

    myAuraHexes.forEach(h => {
      const hexKey = `${h.q},${h.r}`;
      let isIntercepted = false;
      let isDraw = false;

      // Check all units in the grid to see if an enemy contests this specific hex 'h'
      for (const [enemyKey, enemyStack] of grid) {
        if (enemyStack.owner === player) continue; // Skip allies

        const [eq, er] = enemyKey.split(',').map(Number);
        const distToEnemy = getDistance(h, { q: eq, r: er });
        const enemyAuraRange = (enemyStack.count === 1) ? 2 : 1;

        // If the hex is within an enemy's aura range
        if (distToEnemy <= enemyAuraRange) {
          if (enemyStack.count > stack.count) {
            isIntercepted = true; // Enemy is stronger, they push you back
            break; 
          } else if (enemyStack.count === stack.count) {
            isDraw = true; // Equal strength, creates no-man's land
          }
        }
      }

      // Only add to your frontline if you are strictly stronger
      if (!isIntercepted && !isDraw) {
        finalAura.add(hexKey);
      }
    });

    for (const [otherKey, otherStack] of grid) {
      if (otherStack.owner !== player || connectedAllies.has(otherKey)) {
        continue;
      }
      
      const [oq, or] = otherKey.split(',').map(Number);
      const dist = getDistance(currentPos, {q: oq, r: or});
      
      const otherIsScout = otherStack.count === 1;
      
      if (dist <= auraRange + 2) {
        checkQueue.push({q: oq, r: or});
      } else if (dist === auraRange + 3 && otherIsScout) {
        checkQueue.push({q: oq, r: or});
      }
    }
  }
  return Array.from(finalAura);
}

const getReachableHexes = (start: {q: number, r: number}, moveSpeed: number, grid: Map<string, Stack>) => {
  const visited = new Set<string>();
  const queue: { q: number, r: number, dist: number }[] = [{ ...start, dist: 0 }];
  const startKey = `${start.q},${start.r}`;
  visited.add(startKey);
  
  const reachableEmpty = new Set<string>();
  const reachableAllies = new Set<string>();
  const entryHexesForEnemy = new Map<string, Set<string>>();

  const startStack = grid.get(startKey);
  const player = startStack?.owner;
  const canMoveDiagonally = startStack?.count === 2 || (startStack?.isKing && startStack?.count === 1);

  while (queue.length > 0) {
    const current = queue.shift()!;
    
    if (current.dist > 0) {
      const key = `${current.q},${current.r}`;
      const stack = grid.get(key);
      if (!stack) {
        reachableEmpty.add(key);
      } else if (stack.owner === player && stack.count < 5 && !stack.isKing) {
        reachableAllies.add(key);
      }
    }

    if (current.dist < moveSpeed) {
      let neighbors = getNeighbors(current.q, current.r);
      if (canMoveDiagonally) {
        neighbors = neighbors.concat(getDiagonalNeighbors(current.q, current.r));
      }
      for (const neighbor of neighbors) {
        const nKey = `${neighbor.q},${neighbor.r}`;
        if (!visited.has(nKey)) {
          const nStack = grid.get(nKey);
          if (!nStack) {
            visited.add(nKey);
            queue.push({ ...neighbor, dist: current.dist + 1 });
          } else {
            visited.add(nKey);
            if (nStack.owner === player && nStack.count < 5 && !nStack.isKing) {
              reachableAllies.add(nKey);
            }
          }
        }
      }
    }
  }

  const validEnemies = new Set<string>();
  reachableEmpty.add(startKey);

  for (const emptyKey of reachableEmpty) {
    const [eq, er] = emptyKey.split(',').map(Number);
    let attackNeighbors = getNeighbors(eq, er);
    // if (isTwoStack) {
    //   attackNeighbors = attackNeighbors.concat(getDiagonalNeighbors(eq, er));
    // }
    for (const neighbor of attackNeighbors) {
      const nKey = `${neighbor.q},${neighbor.r}`;
      const nStack = grid.get(nKey);
      if (nStack && nStack.owner !== player) {
        validEnemies.add(nKey);
        if (!entryHexesForEnemy.has(nKey)) {
          entryHexesForEnemy.set(nKey, new Set());
        }
        entryHexesForEnemy.get(nKey)!.add(emptyKey);
      }
    }
  }
  
  reachableEmpty.delete(startKey);

  return {
    reachableEmpty,
    reachableAllies,
    validEnemies,
    entryHexesForEnemy
  };
};

type ActionState = 'idle' | 'moving' | 'combining' | 'attacking_target' | 'attacking_entry' | 'special_menu' | 'coordinated_strike_target' | 'coordinated_strike_select_allies' | 'splinter_select_amount';

const calculateBattlePower = (attacker: Stack, defender: Stack, targetHex: {q: number, r: number}, terrainGrid: Map<string, { type: string }>) => {
  const basePower = attacker.count;
  let attackerMods = 0;
  
  const targetKey = `${targetHex.q},${targetHex.r}`;
  const isFort = terrainGrid.get(targetKey)?.type === 'fort';
  
  if (isFort) {
    attackerMods -= 1;
  }
  
  const isCavalry = attacker.count === 2 || (attacker.isKing && attacker.count === 1);
  if (isCavalry) {
    attackerMods += 1;
  }
  
  const finalAttackerPower = Math.max(0, basePower + attackerMods);
  
  const defenderPower = defender.count;
  const finalDefenderPower = defenderPower;
  
  let breakdown = "No modifiers";
  if (isFort || isCavalry) {
    const parts = [];
    if (isCavalry) parts.push("+1 (Cavalry Bonus)");
    if (isFort) parts.push("-1 (Fort Penalty)");
    breakdown = parts.join(", ");
  }
  
  return {
    basePower,
    attackerMods,
    finalAttackerPower,
    defenderPower,
    finalDefenderPower,
    breakdown
  };
};

type SplinterInfo = { stack: Stack, sourceKey: string };

type PopupState = 
  | null
  | { type: 'combine_limit', excess: number, targetKey: string, sourceKey: string, splinter?: SplinterInfo }
  | { type: 'combat_report', attackerKey: string, defenderKey: string, entryKey: string, attackerStart: number, defenderStart: number, attackerRemaining: number, defenderRemaining: number, attackerOwner: number, defenderOwner: number, splinter?: SplinterInfo }
  | { type: 'combat_salvage', attackerKey: string, defenderKey: string, entryKey: string, attackerRemaining: number, defenderRemaining: number, splinter?: SplinterInfo }
  | { type: 'combat_advance', attackerKey: string, defenderKey: string, entryKey: string, attackerRemaining: number, splinter?: SplinterInfo }
  | { type: 'coordinated_strike_report', targetKey: string, primaryAttackerKey: string, participants: { key: string, startCount: number, remainingCount: number }[], defenderStart: number, defenderRemaining: number, defenderOwner: number, attackerOwner: number }
  | { type: 'coordinated_strike_salvage', targetKey: string, primaryAttackerKey: string, participants: { key: string, startCount: number, remainingCount: number }[], defenderRemaining: number, attackerOwner: number }
  | { type: 'coordinated_strike_advance', primaryAttackerKey: string, targetKey: string, participants: { key: string, startCount: number, remainingCount: number }[], attackerOwner: number };

type GameStateSnapshot = {
  grid: Map<string, Stack>;
  terrainGrid: Map<string, { type: string }>;
  reserves: Record<Player, number>;
  ap: number;
  kingPos: { p1: { q: number, r: number } | null, p2: { q: number, r: number } | null };
  stallTimers: Record<Player, number>;
  minTotalUnits: Record<Player, number>;
  minReserves: Record<Player, number>;
  isDoomed: boolean;
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerDownInfo = useRef<{ x: number, y: number, button: number, pointerType: string, isPan: boolean } | null>(null);
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [grid, setGrid] = useState<Map<string, Stack>>(new Map());
  const [kingPos, setKingPos] = useState<{ p1: { q: number, r: number } | null, p2: { q: number, r: number } | null }>({ p1: null, p2: null });

  const [terrainGrid, setTerrainGrid] = useState<Map<string, { type: string }>>(new Map());
  const [currentPlayer, setCurrentPlayer] = useState<Player>(1);
  const [ap, setAp] = useState<number>(1);
  const [turnNumber, setTurnNumber] = useState<number>(1);
  const [showBothFrontlines, setShowBothFrontlines] = useState<boolean>(false);

  const currentFrontlineSet = useMemo(() => {
    return new Set(getActiveFrontline(currentPlayer, grid, kingPos));
  }, [grid, currentPlayer, kingPos]);

  const opponentFrontlineSet = useMemo(() => {
    return new Set(getActiveFrontline(currentPlayer === 1 ? 2 : 1, grid, kingPos));
  }, [grid, currentPlayer, kingPos]);

  const [history, setHistory] = useState<GameStateSnapshot[]>([]);
  
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [isPinching, setIsPinching] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPan, setLastPan] = useState({ x: 0, y: 0 });
  const [hoveredHex, setHoveredHex] = useState<{ q: number; r: number } | null>(null);
  const [selectedStack, setSelectedStack] = useState<{ q: number; r: number } | null>(null);
  const [reserves, setReserves] = useState<Record<Player, number>>({ 1: STARTING_RESERVES, 2: STARTING_RESERVES });
  const [stallTimers, setStallTimers] = useState<Record<Player, number>>({ 1: STALL_TIMER_DEFAULT, 2: STALL_TIMER_DEFAULT });
  const [minTotalUnits, setMinTotalUnits] = useState<Record<Player, number>>({ 1: 0, 2: 0 });
  const [minReserves, setMinReserves] = useState<Record<Player, number>>({ 1: STARTING_RESERVES, 2: STARTING_RESERVES });
  const [isDoomed, setIsDoomed] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [actionState, setActionState] = useState<ActionState>('idle');
  const [highlightedHexes, setHighlightedHexes] = useState<Set<string>>(new Set());
  const [attackTarget, setAttackTarget] = useState<{q: number, r: number} | null>(null);
  const [entryHexesMap, setEntryHexesMap] = useState<Map<string, Set<string>>>(new Map());
  const [strikeAllies, setStrikeAllies] = useState<string[]>([]);
  const [potentialStrikeAllies, setPotentialStrikeAllies] = useState<Set<string>>(new Set());
  const [draggedAllyIndex, setDraggedAllyIndex] = useState<number | null>(null);
  const [hoveredAllyKey, setHoveredAllyKey] = useState<string | null>(null);
  const [popupState, setPopupState] = useState<PopupState>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [splinterAction, setSplinterAction] = useState<'move' | 'combine' | 'attack' | null>(null);
  const [splitAmount, setSplitAmount] = useState<number>(1);
  const [activeSplinter, setActiveSplinter] = useState<SplinterInfo | null>(null);

  const [captureProgress, setCaptureProgress] = useState<{ p1: number, p2: number }>({ p1: 0, p2: 0 });
  const [winner, setWinner] = useState<Player | null>(null);
  const [winMessage, setWinMessage] = useState<string | null>(null);
  const [castlePos, setCastlePos] = useState<{ p1: { q: number, r: number } | null, p2: { q: number, r: number } | null }>({ p1: null, p2: null });

  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 3000);
  };

  const boardCount = { 1: 0, 2: 0 };
  grid.forEach((stack) => {
    boardCount[stack.owner] += stack.count;
  });

  const cameraRef = useRef(camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const bind = useGesture(
    {
      onPinch: ({ 
        origin: [ox, oy], 
        first, 
        last, 
        active,
        offset: [d] 
      }) => {
        if (first) {
          setIsPinching(true);
          setIsPanning(false);

          return { 
            lastZoom: cameraRef.current.zoom,
          };
        }
        
        if (last) {
          setIsPinching(false);
          return;
        }

        const canvas = canvasRef.current;
        if (!canvas || !active) return;

        const rect = canvas.getBoundingClientRect();
        const cx = (ox - rect.left) * (canvas.width / rect.width);
        const cy = (oy - rect.top) * (canvas.height / rect.height);
        const zoomRatio = d / camera.zoom;

        setCamera(prev => ({
          zoom: d,
          x: cx - (cx - prev.x) * zoomRatio,
          y: cy - (cy - prev.y) * zoomRatio,
        }));
      },
    },
    {
      pinch: { 
        from: () => [cameraRef.current.zoom, 0], 
        scaleBounds: { min: MIN_ZOOM, max: MAX_ZOOM }
      }
    }
  );

  useEffect(() => {
    const generateStartingBoard = () => {
      const newGrid = new Map<string, Stack>();
      const newTerrainGrid = new Map<string, { type: string }>();

      let p1King: { q: number, r: number } | null = null;
      let p2King: { q: number, r: number } | null = null;

      INITIAL_LAYOUT.forEach(({ q, r, count }) => {
        // Player 1 (Bottom)
        const p1q = q;
        const p1r = r + BOARD_GAP / 2;
        const p1Key = `${p1q},${p1r}`;
        newGrid.set(p1Key, { owner: 1, count, isKing: count === 6 });
        if (count === 6) p1King = { q: p1q, r: p1r };
        if (count >= 5 || count === 6) {
          newTerrainGrid.set(p1Key, { type: 'fort' });
        }

        // Player 2 (Top)
        const p2q = -q;
        const p2r = -r - BOARD_GAP / 2;
        const p2Key = `${p2q},${p2r}`;
        newGrid.set(p2Key, { owner: 2, count, isKing: count === 6 });
        if (count === 6) p2King = { q: p2q, r: p2r };
        if (count >= 5 || count === 6) {
          newTerrainGrid.set(p2Key, { type: 'fort' });
        }
      });

      setGrid(newGrid);
      setTerrainGrid(newTerrainGrid);
      setKingPos({ p1: p1King, p2: p2King });
      setCastlePos({ p1: p1King, p2: p2King });
      setCaptureProgress({ p1: 0, p2: 0 });
      setWinner(null);
      setWinMessage(null);
      
      let p1BoardCount = 0;
      let p2BoardCount = 0;
      newGrid.forEach((stack) => {
        if (stack.owner === 1) p1BoardCount += stack.count;
        else p2BoardCount += stack.count;
      });
      setMinTotalUnits({ 1: p1BoardCount + STARTING_RESERVES, 2: p2BoardCount + STARTING_RESERVES });
      setMinReserves({ 1: STARTING_RESERVES, 2: STARTING_RESERVES });
      setStallTimers({ 1: STALL_TIMER_DEFAULT, 2: STALL_TIMER_DEFAULT });
      setIsDoomed(false);

      // Camera Centering
      const k1 = axialToPixel(0, BOARD_GAP / 2, HEX_SIZE);
      const k2 = axialToPixel(0, -BOARD_GAP / 2, HEX_SIZE);
      const midX = (k1.x + k2.x) / 2;
      const midY = (k1.y + k2.y) / 2;

      setCamera((c) => ({ ...c, x: -midX * c.zoom, y: -midY * c.zoom }));
    };

    generateStartingBoard();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f172a'; // slate-900
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 + camera.x, height / 2 + camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    const s = HEX_SIZE;

    const left = (-width / 2 - camera.x) / camera.zoom;
    const right = (width / 2 - camera.x) / camera.zoom;
    const top = (-height / 2 - camera.y) / camera.zoom;
    const bottom = (height / 2 - camera.y) / camera.zoom;

    const corners = [
      pixelToAxial(left, top, s),
      pixelToAxial(right, top, s),
      pixelToAxial(right, bottom, s),
      pixelToAxial(left, bottom, s),
    ];

    let minQ = Infinity, maxQ = -Infinity;
    let minR = Infinity, maxR = -Infinity;
    for (const c of corners) {
      minQ = Math.min(minQ, c.q);
      maxQ = Math.max(maxQ, c.q);
      minR = Math.min(minR, c.r);
      maxR = Math.max(maxR, c.r);
    }

    minQ = Math.floor(minQ) - 1;
    maxQ = Math.ceil(maxQ) + 1;
    minR = Math.floor(minR) - 1;
    maxR = Math.ceil(maxR) + 1;

    ctx.strokeStyle = '#334155'; // slate-700
    ctx.lineWidth = 2 / camera.zoom;
    ctx.lineJoin = 'round';

    // Draw all hexes as a single path for performance
    ctx.beginPath();
    for (let q = minQ; q <= maxQ; q++) {
      for (let r = minR; r <= maxR; r++) {
        const { x, y } = axialToPixel(q, r, s);
        for (let i = 0; i < 6; i++) {
          const angle_rad = (Math.PI / 180) * (60 * i);
          const px = x + s * Math.cos(angle_rad);
          const py = y + s * Math.sin(angle_rad);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();

    // Layer 2: Terrain
    for (let q = minQ; q <= maxQ; q++) {
      for (let r = minR; r <= maxR; r++) {
        const key = `${q},${r}`;
        const terrain = terrainGrid.get(key);
        if (terrain && terrain.type === 'fort') {
          const { x, y } = axialToPixel(q, r, s);
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const angle_rad = (Math.PI / 180) * (60 * i);
            const px = x + (s * 0.8) * Math.cos(angle_rad);
            const py = y + (s * 0.8) * Math.sin(angle_rad);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = '#334155'; // slate-700
          ctx.fill();
          ctx.strokeStyle = '#64748b'; // slate-500
          ctx.lineWidth = 2 / camera.zoom;
          ctx.stroke();

          if (castlePos.p1 && castlePos.p1.q === q && castlePos.p1.r === r) {
            ctx.font = `${s * 0.5}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🏰', x, y - s * 0.4);
            if (captureProgress.p2 > 0) {
              ctx.fillStyle = '#ef4444';
              ctx.font = `bold ${s * 0.3}px sans-serif`;
              ctx.fillText(`${captureProgress.p2}/3`, x, y + s * 0.4);
            }
          } else if (castlePos.p2 && castlePos.p2.q === q && castlePos.p2.r === r) {
            ctx.font = `${s * 0.5}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🏰', x, y - s * 0.4);
            if (captureProgress.p1 > 0) {
              ctx.fillStyle = '#3b82f6';
              ctx.font = `bold ${s * 0.3}px sans-serif`;
              ctx.fillText(`${captureProgress.p1}/3`, x, y + s * 0.4);
            }
          }
        }
      }
    }

    // Layer 2.5: Frontline Aura
    const drawFrontline = (frontlineSet: Set<string>, player: Player) => {
      frontlineSet.forEach(key => {
        const [q, r] = key.split(',').map(Number);
        const { x, y } = axialToPixel(q, r, s);
        
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle_rad = (Math.PI / 180) * (60 * i);
          const px = x + s * Math.cos(angle_rad);
          const py = y + s * Math.sin(angle_rad);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        
        ctx.save();
        const playerColor = player === 1 ? '#3b82f6' : '#ef4444'; // blue-500 : red-500
        ctx.fillStyle = player === 1 ? 'rgba(59, 130, 246, 0.1)' : 'rgba(239, 68, 68, 0.1)';
        ctx.shadowColor = playerColor;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.restore();

        const neighbors = getNeighbors(q, r);
        ctx.strokeStyle = playerColor;
        ctx.lineWidth = 2 / camera.zoom;
        ctx.lineCap = 'round';
        
        for (let i = 0; i < 6; i++) {
          const neighbor = neighbors[i];
          const nKey = `${neighbor.q},${neighbor.r}`;
          if (!frontlineSet.has(nKey)) {
            const edgeIndex = (6 - i) % 6;
            const angle1 = (Math.PI / 180) * (60 * edgeIndex);
            const angle2 = (Math.PI / 180) * (60 * ((edgeIndex + 1) % 6));
            
            ctx.beginPath();
            ctx.moveTo(x + s * Math.cos(angle1), y + s * Math.sin(angle1));
            ctx.lineTo(x + s * Math.cos(angle2), y + s * Math.sin(angle2));
            ctx.stroke();
          }
        }
      });
    };

    drawFrontline(currentFrontlineSet, currentPlayer);
    if (showBothFrontlines) {
      drawFrontline(opponentFrontlineSet, currentPlayer === 1 ? 2 : 1);
    }

    // Highlight hovered hex
    if (hoveredHex) {
      const key = `${hoveredHex.q},${hoveredHex.r}`;
      const stack = grid.get(key);
      if (stack) {
        const { x, y } = axialToPixel(hoveredHex.q, hoveredHex.r, s);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle_rad = (Math.PI / 180) * (60 * i);
          const px = x + s * Math.cos(angle_rad);
          const py = y + s * Math.sin(angle_rad);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fill();
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 3 / camera.zoom;
        ctx.stroke();
      }
    }

    // Highlight selected hex
    if (selectedStack) {
      const { x, y } = axialToPixel(selectedStack.q, selectedStack.r, s);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle_rad = (Math.PI / 180) * (60 * i);
        const px = x + s * Math.cos(angle_rad);
        const py = y + s * Math.sin(angle_rad);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(250, 204, 21, 0.2)'; // yellow-400 with opacity
      ctx.fill();
      ctx.strokeStyle = '#facc15'; // yellow-400
      ctx.lineWidth = 4 / camera.zoom;
      ctx.stroke();
    }

    // Draw highlighted hexes
    highlightedHexes.forEach(key => {
      const [hq, hr] = key.split(',').map(Number);
      const { x: hx, y: hy } = axialToPixel(hq, hr, s);
      
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle_rad = (Math.PI / 180) * (60 * i);
        const px = hx + s * Math.cos(angle_rad);
        const py = hy + s * Math.sin(angle_rad);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      
      let fillColor = 'rgba(250, 204, 21, 0.4)';
      let strokeColor = 'rgba(250, 204, 21, 0.8)';
      
      if (actionState === 'attacking_target' || actionState === 'coordinated_strike_target') {
        fillColor = 'rgba(239, 68, 68, 0.4)';
        strokeColor = 'rgba(239, 68, 68, 0.8)';
      } else if (actionState === 'combining') {
        fillColor = 'rgba(59, 130, 246, 0.4)';
        strokeColor = 'rgba(59, 130, 246, 0.8)';
      } else if (actionState === 'attacking_entry') {
        fillColor = 'rgba(249, 115, 22, 0.4)';
        strokeColor = 'rgba(249, 115, 22, 0.8)';
      }
      
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.lineWidth = 3 / camera.zoom;
      ctx.strokeStyle = strokeColor;
      ctx.stroke();
    });

    if (actionState === 'coordinated_strike_select_allies') {
      const drawHex = (key: string, fillColor: string, strokeColor: string) => {
        const [hq, hr] = key.split(',').map(Number);
        const { x: hx, y: hy } = axialToPixel(hq, hr, s);
        
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle_rad = (Math.PI / 180) * (60 * i);
          const px = hx + s * Math.cos(angle_rad);
          const py = hy + s * Math.sin(angle_rad);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.lineWidth = 3 / camera.zoom;
        ctx.strokeStyle = strokeColor;
        ctx.stroke();
      };

      potentialStrikeAllies.forEach(key => {
        if (!strikeAllies.includes(key)) {
          drawHex(key, 'rgba(34, 197, 94, 0.4)', 'rgba(34, 197, 94, 0.8)'); // Green
        }
      });

      strikeAllies.forEach(key => {
        drawHex(key, 'rgba(128, 0, 0, 0.4)', 'rgba(128, 0, 0, 0.8)'); // Maroon
        
        if (hoveredAllyKey === key) {
          drawHex(key, 'rgba(255, 255, 255, 0.3)', 'rgba(255, 255, 255, 1.0)'); // White highlight
        }
      });
    }

    // Draw stacks
    for (let q = minQ; q <= maxQ; q++) {
      for (let r = minR; r <= maxR; r++) {
        const key = `${q},${r}`;
        let stack = grid.get(key);
        
        if (activeSplinter && activeSplinter.sourceKey === key) {
          const originalStack = stack!;
          stack = { ...originalStack, count: originalStack.count - activeSplinter.stack.count };
        }
        
        if (stack) {
          const { x, y } = axialToPixel(q, r, s);
          ctx.beginPath();
          ctx.arc(x, y, s * 0.55, 0, 2 * Math.PI);
          ctx.fillStyle = stack.owner === 1 ? '#3b82f6' : '#ef4444'; // blue-500 : red-500
          ctx.fill();

          if (stack.isKing) {
            ctx.strokeStyle = '#fbbf24'; // amber-400
            ctx.lineWidth = 3 / camera.zoom;
            ctx.stroke();
          }

          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${s * 0.55}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(stack.count.toString(), x, y);

          if (camera.zoom >= 1.2) {
            const piece = PIECE_TYPES[stack.count];
            if (piece || stack.isKing) {
              ctx.fillStyle = stack.isKing ? '#fbbf24' : '#cbd5e1';
              ctx.font = `600 ${s * 0.25}px sans-serif`;
              ctx.fillText(stack.isKing ? PIECE_TYPES[6].name : piece?.name || '', x, y + s * 0.85);
            }
          }
          
          if (isDoomed && stack.isKing) {
            ctx.fillStyle = '#ef4444';
            ctx.font = `${s * 0.5}px sans-serif`;
            ctx.fillText('☠️', x, y - s * 0.6);
          }
          
          if (activeSplinter && activeSplinter.sourceKey === key) {
             // Draw the splintered stack slightly offset
             const offset = s * 0.4;
             ctx.beginPath();
             ctx.arc(x + offset, y - offset, s * 0.35, 0, 2 * Math.PI);
             ctx.fillStyle = activeSplinter.stack.owner === 1 ? '#60a5fa' : '#f87171'; // lighter blue/red
             ctx.fill();
             ctx.strokeStyle = '#ffffff';
             ctx.lineWidth = 2 / camera.zoom;
             ctx.stroke();
             
             ctx.fillStyle = '#ffffff';
             ctx.font = `bold ${s * 0.35}px sans-serif`;
             ctx.fillText(activeSplinter.stack.count.toString(), x + offset, y - offset);
          }
        }
      }
    }

    ctx.restore();
  }, [grid, terrainGrid, camera, hoveredHex, selectedStack, highlightedHexes, actionState, activeSplinter, currentFrontlineSet, opponentFrontlineSet, currentPlayer, showBothFrontlines, castlePos, captureProgress, isDoomed]);

  useEffect(() => {
    const handleResize = () => {
      const width = window.visualViewport ? window.visualViewport.width : window.innerWidth;
      const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      
      setWindowSize({ width, height });
      
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = width;
        canvas.height = height;
        draw();
      }
    };
    window.addEventListener('resize', handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
    }
    handleResize();
    return () => {
      window.removeEventListener('resize', handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      }
    };
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw, currentFrontlineSet, opponentFrontlineSet, showBothFrontlines]);

  useEffect(() => {
    if (draggedAllyIndex === null) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetItem = target?.closest('[data-ally-index]');
      if (targetItem) {
        const hoverIndex = parseInt(targetItem.getAttribute('data-ally-index') || '', 10);
        if (!isNaN(hoverIndex) && hoverIndex !== draggedAllyIndex) {
          const newAllies = [...strikeAllies];
          const [movedItem] = newAllies.splice(draggedAllyIndex, 1);
          newAllies.splice(hoverIndex, 0, movedItem);
          setStrikeAllies(newAllies);
          setDraggedAllyIndex(hoverIndex);
        }
      }
    };

    const handleGlobalPointerUp = () => {
      setDraggedAllyIndex(null);
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', handleGlobalPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('pointercancel', handleGlobalPointerUp);
    };
  }, [draggedAllyIndex, strikeAllies]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;

      const zoomFactor = 1.1;
      const direction = e.deltaY < 0 ? 1 : -1;

      setCamera((c) => {
        let newZoom = c.zoom * (direction > 0 ? zoomFactor : 1 / zoomFactor);
        newZoom = Math.max(MIN_ZOOM, Math.min(newZoom, MAX_ZOOM));

        const width = canvas.width;
        const height = canvas.height;
        const wx = (mouseX - width / 2 - c.x) / c.zoom;
        const wy = (mouseY - height / 2 - c.y) / c.zoom;

        const newX = mouseX - width / 2 - wx * newZoom;
        const newY = mouseY - height / 2 - wy * newZoom;

        return { x: newX, y: newY, zoom: newZoom };
      });
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, []);

  const saveHistory = () => {
    setHistory(prev => [...prev, {
      grid: new Map(grid),
      terrainGrid: new Map(terrainGrid),
      reserves: { ...reserves },
      ap,
      kingPos: { ...kingPos },
      stallTimers: { ...stallTimers },
      minTotalUnits: { ...minTotalUnits },
      minReserves: { ...minReserves },
      isDoomed
    }]);
  };

  const handleHexClick = (clientX: number, clientY: number) => {
    if (popupState || winner) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (clientX - rect.left) * scaleX;
    const mouseY = (clientY - rect.top) * scaleY;

    const width = canvas.width;
    const height = canvas.height;

    const wx = (mouseX - width / 2 - camera.x) / camera.zoom;
    const wy = (mouseY - height / 2 - camera.y) / camera.zoom;

    const { q, r } = pixelToAxial(wx, wy, HEX_SIZE);
    const rounded = axialRound(q, r);
    const key = `${rounded.q},${rounded.r}`;
    const existing = grid.get(key);

    if (actionState === 'moving') {
      if (highlightedHexes.has(key)) {
        saveHistory();
        const newGrid = new Map<string, Stack>(grid);
        let movingStack: Stack;
        if (activeSplinter) {
          const sourceStack = newGrid.get(activeSplinter.sourceKey)!;
          newGrid.set(activeSplinter.sourceKey, { ...sourceStack, count: sourceStack.count - activeSplinter.stack.count });
          movingStack = activeSplinter.stack;
        } else {
          movingStack = newGrid.get(`${selectedStack!.q},${selectedStack!.r}`)!;
          newGrid.delete(`${selectedStack!.q},${selectedStack!.r}`);
        }
        newGrid.set(key, movingStack);
        if (movingStack.isKing) {
          setKingPos(prev => ({ ...prev, [movingStack.owner === 1 ? 'p1' : 'p2']: { q: rounded.q, r: rounded.r } }));
        }
        setGrid(newGrid);
        setAp(prev => prev - 1);
        setActionState('idle');
        setSelectedStack(null);
        setHighlightedHexes(new Set());
        setActiveSplinter(null);
      } else {
        setActionState('idle');
        setSelectedStack(null);
        setHighlightedHexes(new Set());
        setActiveSplinter(null);
      }
      return;
    }

    if (actionState === 'combining') {
      if (highlightedHexes.has(key)) {
        const sourceKey = activeSplinter ? activeSplinter.sourceKey : `${selectedStack!.q},${selectedStack!.r}`;
        const sourceStack = activeSplinter ? activeSplinter.stack : grid.get(sourceKey)!;
        const targetStack = grid.get(key)!;
        
        const isKing = sourceStack.isKing || targetStack.isKing;
        const maxCount = isKing ? 6 : 5;
        const newCount = sourceStack.count + targetStack.count;
        
        if (newCount > maxCount) {
          const excess = newCount - maxCount;
          setPopupState({ type: 'combine_limit', excess, targetKey: key, sourceKey, splinter: activeSplinter || undefined });
        } else {
          saveHistory();
          const newGrid = new Map<string, Stack>(grid);
          if (activeSplinter) {
            const originalSource = newGrid.get(sourceKey)!;
            newGrid.set(sourceKey, { ...originalSource, count: originalSource.count - activeSplinter.stack.count });
          } else {
            newGrid.delete(sourceKey);
          }
          newGrid.set(key, { ...targetStack, count: newCount, isKing });
          if (isKing) {
            setKingPos(prev => ({ ...prev, [sourceStack.owner === 1 ? 'p1' : 'p2']: { q: rounded.q, r: rounded.r } }));
          }
          setGrid(newGrid);
          if (newCount >= 5 || isKing) {
            const newTerrainGrid = new Map(terrainGrid);
            newTerrainGrid.set(key, { type: 'fort' });
            setTerrainGrid(newTerrainGrid);
          }
          setAp(prev => prev - 1);
          setActionState('idle');
          setSelectedStack(null);
          setHighlightedHexes(new Set());
          setActiveSplinter(null);
        }
      } else {
        setActionState('idle');
        setSelectedStack(null);
        setHighlightedHexes(new Set());
        setActiveSplinter(null);
      }
      return;
    }

    if (actionState === 'attacking_target') {
      if (highlightedHexes.has(key)) {
        setAttackTarget({ q: rounded.q, r: rounded.r });
        setActionState('attacking_entry');
        setHighlightedHexes(entryHexesMap.get(key) || new Set());
      } else {
        setActionState('idle');
        setSelectedStack(null);
        setHighlightedHexes(new Set());
        setAttackTarget(null);
        setActiveSplinter(null);
      }
      return;
    }

    if (actionState === 'coordinated_strike_target') {
      if (highlightedHexes.has(key)) {
        setAttackTarget({ q: rounded.q, r: rounded.r });
        
        // Find potential allies (adjacent 3-stacks or 4-stacks)
        const potential = new Set<string>();
        for (const neighbor of getNeighbors(rounded.q, rounded.r)) {
          const nKey = `${neighbor.q},${neighbor.r}`;
          const nStack = grid.get(nKey);
          if (nStack && nStack.owner === currentPlayer && (nStack.count === 3 || nStack.count === 4)) {
            if (nKey !== `${selectedStack!.q},${selectedStack!.r}`) {
              potential.add(nKey);
            }
          }
        }
        
        setPotentialStrikeAllies(potential);
        setStrikeAllies([`${selectedStack!.q},${selectedStack!.r}`]);
        setActionState('coordinated_strike_select_allies');
        setHighlightedHexes(new Set()); // Clear red highlights
      } else {
        setActionState('idle');
        setSelectedStack(null);
        setHighlightedHexes(new Set());
        setAttackTarget(null);
      }
      return;
    }

    if (actionState === 'coordinated_strike_select_allies') {
      if (potentialStrikeAllies.has(key)) {
        const newStrikeAllies = [...strikeAllies];
        if (newStrikeAllies.includes(key)) {
          newStrikeAllies.splice(newStrikeAllies.indexOf(key), 1);
        } else {
          newStrikeAllies.push(key);
        }
        setStrikeAllies(newStrikeAllies);
      } else if (key === `${selectedStack!.q},${selectedStack!.r}`) {
        // Primary attacker cannot be deselected
      } else {
        // Clicking elsewhere cancels
        setActionState('idle');
        setSelectedStack(null);
        setStrikeAllies([]);
        setPotentialStrikeAllies(new Set());
        setAttackTarget(null);
      }
      return;
    }

    if (actionState === 'attacking_entry') {
      if (highlightedHexes.has(key)) {
        const sourceKey = activeSplinter ? activeSplinter.sourceKey : `${selectedStack!.q},${selectedStack!.r}`;
        const targetKey = `${attackTarget!.q},${attackTarget!.r}`;
        const entryKey = key;
        
        const sourceStack = activeSplinter ? activeSplinter.stack : grid.get(sourceKey)!;
        const targetStack = grid.get(targetKey)!;
        
        const battleData = calculateBattlePower(sourceStack, targetStack, attackTarget!, terrainGrid);
        
        const attackerDamage = battleData.finalAttackerPower;
        const defenderDamage = battleData.finalDefenderPower;
        
        const targetKeyStr = `${attackTarget!.q},${attackTarget!.r}`;
        const isFort = terrainGrid.get(targetKeyStr)?.type === 'fort';
        const fortDamage = isFort ? 1 : 0;
        const isCavalry = sourceStack.count === 2 || (sourceStack.isKing && sourceStack.count === 1);
        const cavalryBonus = isCavalry ? 1 : 0;
        
        let actualAttackerRemaining = Math.max(0, sourceStack.count - defenderDamage - fortDamage + cavalryBonus);
        const actualDefenderRemaining = Math.max(0, targetStack.count - attackerDamage);
        
        saveHistory();
        setPopupState({
          type: 'combat_report',
          attackerKey: sourceKey,
          defenderKey: targetKey,
          entryKey: entryKey,
          attackerStart: sourceStack.count,
          defenderStart: targetStack.count,
          attackerRemaining: actualAttackerRemaining,
          defenderRemaining: actualDefenderRemaining,
          attackerOwner: sourceStack.owner,
          defenderOwner: targetStack.owner,
          splinter: activeSplinter || undefined
        });
      } else {
        setActionState('idle');
        setSelectedStack(null);
        setHighlightedHexes(new Set());
        setAttackTarget(null);
        setActiveSplinter(null);
      }
      return;
    }

    if (!existing) {
      if (selectedStack) {
        setSelectedStack(null);
        setActionState('idle');
        setHighlightedHexes(new Set());
        setAttackTarget(null);
        setStrikeAllies([]);
        setPotentialStrikeAllies(new Set());
        setActiveSplinter(null);
      } else {
        if (!currentFrontlineSet.has(key)) {
          showToast("Cannot deploy outside of King's influence.");
          return;
        }
        if (ap < 1) return;
        if (reserves[currentPlayer] <= 0) return;
        
        saveHistory();
        const newGrid = new Map<string, Stack>(grid);
        newGrid.set(key, { owner: currentPlayer, count: 1 });
        setGrid(newGrid);
        const newReserve = reserves[currentPlayer] - 1;
        setReserves(prev => ({ ...prev, [currentPlayer]: newReserve }));
        if (newReserve < minReserves[currentPlayer]) {
          setMinReserves(prev => ({ ...prev, [currentPlayer]: newReserve }));
          setStallTimers(prev => ({ ...prev, [currentPlayer]: STALL_TIMER_DEFAULT }));
        }
        setAp(prev => prev - 1);
        setActionState('idle');
        setHighlightedHexes(new Set());
        setAttackTarget(null);
        setStrikeAllies([]);
        setPotentialStrikeAllies(new Set());
        setActiveSplinter(null);
      }
    } else {
      if (existing.owner === currentPlayer) {
        if (selectedStack && selectedStack.q === rounded.q && selectedStack.r === rounded.r) {
          setSelectedStack(null);
          setActionState('idle');
          setHighlightedHexes(new Set());
          setAttackTarget(null);
          setStrikeAllies([]);
          setPotentialStrikeAllies(new Set());
          setActiveSplinter(null);
        } else {
          setSelectedStack({ q: rounded.q, r: rounded.r });
          setActionState('idle');
          setHighlightedHexes(new Set());
          setAttackTarget(null);
          setStrikeAllies([]);
          setPotentialStrikeAllies(new Set());
          setActiveSplinter(null);
        }
      } else {
        setSelectedStack(null);
        setActionState('idle');
        setHighlightedHexes(new Set());
        setAttackTarget(null);
        setStrikeAllies([]);
        setPotentialStrikeAllies(new Set());
        setActiveSplinter(null);
      }
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const isPan = e.button === 2 || e.button === 1 || e.pointerType !== 'mouse';
    pointerDownInfo.current = { x: e.clientX, y: e.clientY, button: e.button, pointerType: e.pointerType, isPan };

    if (isPan) {
      setIsPanning(true);
      setLastPan({ x: e.clientX, y: e.clientY });
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (e.button === 0) {
      handleHexClick(e.clientX, e.clientY);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPinching) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (isPanning && pointerDownInfo.current?.isPan) {
      const dx = e.clientX - lastPan.x;
      const dy = e.clientY - lastPan.y;
      setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
      setLastPan({ x: e.clientX, y: e.clientY });
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

    const width = canvas.width;
    const height = canvas.height;

    const wx = (mouseX - width / 2 - camera.x) / camera.zoom;
    const wy = (mouseY - height / 2 - camera.y) / camera.zoom;

    const { q, r } = pixelToAxial(wx, wy, HEX_SIZE);
    const rounded = axialRound(q, r);

    setMousePos({ x: e.clientX, y: e.clientY });

    setHoveredHex((prev) => {
      if (prev?.q === rounded.q && prev?.r === rounded.r) return prev;
      return { q: rounded.q, r: rounded.r };
    });
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setHoveredHex(null);
    if (isPanning) {
      setIsPanning(false);
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    pointerDownInfo.current = null;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      setIsPanning(false);
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (pointerDownInfo.current) {
      const dx = Math.abs(e.clientX - pointerDownInfo.current.x);
      const dy = Math.abs(e.clientY - pointerDownInfo.current.y);
      const dist = Math.sqrt(dx * dx + dy * dy);

      // If it was a touch tap (didn't move much), treat it as a click
      if (pointerDownInfo.current.pointerType !== 'mouse' && dist < 10) {
        handleHexClick(e.clientX, e.clientY);
      }
    }
    pointerDownInfo.current = null;
  };

  const handleCombatResolution = (salvage: boolean, state: Extract<PopupState, { type: 'combat_salvage' }>) => {
    if (salvage) {
      setReserves(prev => ({ ...prev, [currentPlayer]: prev[currentPlayer] + 1 }));
      setMinReserves(prev => ({ ...prev, [currentPlayer]: prev[currentPlayer] + 1 }));
    }
    
    if (state.defenderRemaining === 0 && state.attackerRemaining > 0) {
      setPopupState({
        type: 'combat_advance',
        attackerKey: state.attackerKey,
        defenderKey: state.defenderKey,
        entryKey: state.entryKey,
        attackerRemaining: state.attackerRemaining,
        splinter: state.splinter
      });
    } else {
      finalizeCombat(state.attackerKey, state.defenderKey, state.entryKey, state.attackerRemaining, state.defenderRemaining, false, state.splinter);
    }
  };

  const handleAdvanceResolution = (advance: boolean, state: Extract<PopupState, { type: 'combat_advance' }>) => {
    finalizeCombat(state.attackerKey, state.defenderKey, state.entryKey, state.attackerRemaining, 0, advance, state.splinter);
  };

  const finalizeCombat = (attackerKey: string, defenderKey: string, entryKey: string, attackerRemaining: number, defenderRemaining: number, advance: boolean, splinter?: SplinterInfo) => {
    const newGrid = new Map<string, Stack>(grid);
    const attackerStack = splinter ? splinter.stack : newGrid.get(attackerKey)!;
    const defenderStack = newGrid.get(defenderKey)!;
    
    if (splinter) {
      const originalSource = newGrid.get(splinter.sourceKey)!;
      newGrid.set(splinter.sourceKey, { ...originalSource, count: originalSource.count - splinter.stack.count });
    } else {
      newGrid.delete(attackerKey);
    }
    
    if (defenderRemaining > 0) {
      newGrid.set(defenderKey, { ...defenderStack, count: defenderRemaining });
    } else {
      newGrid.delete(defenderKey);
      if (defenderStack.isKing) {
        setKingPos(prev => ({ ...prev, [defenderStack.owner === 1 ? 'p1' : 'p2']: null }));
        setWinner(attackerStack.owner);
        setWinMessage(`Player ${attackerStack.owner} wins! The Enemy King has fallen.`);
      }
    }
    
    if (attackerRemaining > 0) {
      if (advance) {
        newGrid.set(defenderKey, { ...attackerStack, count: attackerRemaining });
        if (attackerStack.isKing) {
          const [qStr, rStr] = defenderKey.split(',');
          setKingPos(prev => ({ ...prev, [attackerStack.owner === 1 ? 'p1' : 'p2']: { q: parseInt(qStr), r: parseInt(rStr) } }));
        }
      } else {
        newGrid.set(entryKey, { ...attackerStack, count: attackerRemaining });
        if (attackerStack.isKing) {
          const [qStr, rStr] = entryKey.split(',');
          setKingPos(prev => ({ ...prev, [attackerStack.owner === 1 ? 'p1' : 'p2']: { q: parseInt(qStr), r: parseInt(rStr) } }));
        }
      }
    } else if (attackerStack.isKing) {
      setKingPos(prev => ({ ...prev, [attackerStack.owner === 1 ? 'p1' : 'p2']: null }));
      if (defenderRemaining > 0) {
        setWinner(defenderStack.owner);
        setWinMessage(`Player ${defenderStack.owner} wins! The Enemy King has fallen.`);
      }
    }
    
    setGrid(newGrid);
    setAp(prev => prev - 1);
    
    setPopupState(null);
    setActionState('idle');
    setSelectedStack(null);
    setHighlightedHexes(new Set());
    setAttackTarget(null);
    setActiveSplinter(null);
  };

  const handleCoordinatedStrikeReport = (state: Extract<PopupState, { type: 'coordinated_strike_report' }>) => {
    const anyDamaged = state.participants.some(p => p.remainingCount < p.startCount);
    if (anyDamaged) {
      setPopupState({
        type: 'coordinated_strike_salvage',
        targetKey: state.targetKey,
        primaryAttackerKey: state.primaryAttackerKey,
        participants: state.participants,
        defenderRemaining: state.defenderRemaining,
        attackerOwner: state.attackerOwner
      });
    } else {
      const primaryAlive = state.participants.find(p => p.key === state.primaryAttackerKey)?.remainingCount! > 0;
      if (state.defenderRemaining === 0 && primaryAlive) {
        setPopupState({
          type: 'coordinated_strike_advance',
          primaryAttackerKey: state.primaryAttackerKey,
          targetKey: state.targetKey,
          participants: state.participants,
          attackerOwner: state.attackerOwner
        });
      } else {
        finalizeCoordinatedStrike(state.targetKey, state.participants, state.defenderRemaining, false, state.primaryAttackerKey);
      }
    }
  };

  const handleCoordinatedStrikeSalvage = (salvageSelections: Record<string, boolean>, state: Extract<PopupState, { type: 'coordinated_strike_salvage' }>) => {
    let salvageCount = 0;
    for (const key in salvageSelections) {
      if (salvageSelections[key]) salvageCount++;
    }
    if (salvageCount > 0) {
      setReserves(prev => ({ ...prev, [currentPlayer]: prev[currentPlayer] + salvageCount }));
      setMinReserves(prev => ({ ...prev, [currentPlayer]: prev[currentPlayer] + salvageCount }));
    }

    const primaryAlive = state.participants.find(p => p.key === state.primaryAttackerKey)?.remainingCount! > 0;
    if (state.defenderRemaining === 0 && primaryAlive) {
      setPopupState({
        type: 'coordinated_strike_advance',
        primaryAttackerKey: state.primaryAttackerKey,
        targetKey: state.targetKey,
        participants: state.participants,
        attackerOwner: state.attackerOwner
      });
    } else {
      finalizeCoordinatedStrike(state.targetKey, state.participants, state.defenderRemaining, false, state.primaryAttackerKey);
    }
  };

  const handleCoordinatedStrikeAdvance = (advance: boolean, state: Extract<PopupState, { type: 'coordinated_strike_advance' }>) => {
    finalizeCoordinatedStrike(state.targetKey, state.participants, 0, advance, state.primaryAttackerKey);
  };

  const finalizeCoordinatedStrike = (targetKey: string, participants: { key: string, remainingCount: number }[], defenderRemaining: number, advance: boolean, primaryAttackerKey: string) => {
    const newGrid = new Map<string, Stack>(grid);
    const targetStack = newGrid.get(targetKey)!;

    if (defenderRemaining > 0) {
      newGrid.set(targetKey, { ...targetStack, count: defenderRemaining });
    } else {
      newGrid.delete(targetKey);
      if (targetStack.isKing) {
        setKingPos(prev => ({ ...prev, [targetStack.owner === 1 ? 'p1' : 'p2']: null }));
        const attackerOwner = targetStack.owner === 1 ? 2 : 1;
        setWinner(attackerOwner);
        setWinMessage(`Player ${attackerOwner} wins! The Enemy King has fallen.`);
      }
    }

    for (const p of participants) {
      const pStack = newGrid.get(p.key)!;
      if (advance && p.key === primaryAttackerKey) {
        newGrid.delete(p.key);
        if (p.remainingCount > 0) {
          newGrid.set(targetKey, { ...pStack, count: p.remainingCount });
          if (pStack.isKing) {
            const [qStr, rStr] = targetKey.split(',');
            setKingPos(prev => ({ ...prev, [pStack.owner === 1 ? 'p1' : 'p2']: { q: parseInt(qStr), r: parseInt(rStr) } }));
          }
        } else if (pStack.isKing) {
          setKingPos(prev => ({ ...prev, [pStack.owner === 1 ? 'p1' : 'p2']: null }));
          if (defenderRemaining > 0) {
            setWinner(targetStack.owner);
            setWinMessage(`Player ${targetStack.owner} wins! The Enemy King has fallen.`);
          }
        }
      } else {
        if (p.remainingCount > 0) {
          newGrid.set(p.key, { ...pStack, count: p.remainingCount });
        } else {
          newGrid.delete(p.key);
          if (pStack.isKing) {
            setKingPos(prev => ({ ...prev, [pStack.owner === 1 ? 'p1' : 'p2']: null }));
            if (defenderRemaining > 0) {
              setWinner(targetStack.owner);
              setWinMessage(`Player ${targetStack.owner} wins! The Enemy King has fallen.`);
            }
          }
        }
      }
    }

    setGrid(newGrid);
    setAp(prev => prev - 1);
    
    setPopupState(null);
    setActionState('idle');
    setSelectedStack(null);
    setHighlightedHexes(new Set());
    setAttackTarget(null);
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const lastState = history[history.length - 1];
    setGrid(lastState.grid);
    setTerrainGrid(lastState.terrainGrid);
    setReserves(lastState.reserves);
    setAp(lastState.ap);
    setKingPos(lastState.kingPos);
    setStallTimers(lastState.stallTimers);
    setMinTotalUnits(lastState.minTotalUnits);
    setMinReserves(lastState.minReserves);
    setIsDoomed(lastState.isDoomed);
    setHistory(history.slice(0, -1));
    setSelectedStack(null);
    setActiveSplinter(null);
  };

  const handleConfirm = () => {
    const nextPlayer = currentPlayer === 1 ? 2 : 1;
    let currentGrid = new Map<string, Stack>(grid);
    let currentMinTotalUnits = { ...minTotalUnits };

    if (isDoomed) {
      const kingPosObj = currentPlayer === 1 ? kingPos.p1 : kingPos.p2;
      if (kingPosObj) {
        const kingKey = `${kingPosObj.q},${kingPosObj.r}`;
        const kingStack = currentGrid.get(kingKey);
        if (kingStack) {
          const newCount = kingStack.count - 1;
          if (newCount <= 0) {
            setWinner(nextPlayer);
            setWinMessage(`Player ${nextPlayer} wins! Player ${currentPlayer}'s King succumbed to doom.`);
            return;
          } else {
            currentGrid.set(kingKey, { ...kingStack, count: newCount });
            setGrid(currentGrid);
            currentMinTotalUnits[currentPlayer] = Math.max(0, currentMinTotalUnits[currentPlayer] - 1);
            setMinTotalUnits(currentMinTotalUnits);
          }
        }
      }
    }

    let p1BoardCount = 0;
    let p2BoardCount = 0;
    currentGrid.forEach((stack) => {
      if (stack.owner === 1) p1BoardCount += stack.count;
      else p2BoardCount += stack.count;
    });
    
    const p1Total = p1BoardCount + reserves[1];
    const p2Total = p2BoardCount + reserves[2];
    
    const enemyPlayer = nextPlayer;
    const enemyTotal = enemyPlayer === 1 ? p1Total : p2Total;
    
    let currentStallTimer = stallTimers[currentPlayer];
    
    const nextPlayerTurnCount = Math.floor(turnNumber / 2) + 1;
    let nextPlayerStallTimer = stallTimers[nextPlayer];
    if (nextPlayerTurnCount > stallTimerInactiveFirstXTurns) {
      nextPlayerStallTimer = Math.max(0, stallTimers[nextPlayer] - 1);
    }

    if (enemyTotal < currentMinTotalUnits[enemyPlayer]) {
      currentStallTimer = STALL_TIMER_DEFAULT;
      nextPlayerStallTimer = STALL_TIMER_DEFAULT;
    }
    
    const newMinTotalUnits = {
      1: Math.min(currentMinTotalUnits[1], p1Total),
      2: Math.min(currentMinTotalUnits[2], p2Total)
    };
    setMinTotalUnits(newMinTotalUnits);
    
    setStallTimers({
      [currentPlayer]: currentStallTimer,
      [nextPlayer]: nextPlayerStallTimer
    } as Record<Player, number>);

    let nextIsDoomed = isDoomed;
    if (nextIsDoomed && currentStallTimer > 0 && nextPlayerStallTimer > 0) {
      nextIsDoomed = false;
    }
    if (currentStallTimer === 0 || nextPlayerStallTimer === 0) {
      nextIsDoomed = true;
    }
    setIsDoomed(nextIsDoomed);

    setCurrentPlayer(nextPlayer);
    setTurnNumber((t) => t + 1);
    setAp(2);
    setHistory([]);
    setSelectedStack(null);
    setActiveSplinter(null);

    const enemyCastle = nextPlayer === 1 ? castlePos.p2 : castlePos.p1;
    if (enemyCastle) {
      const enemyCastleKey = `${enemyCastle.q},${enemyCastle.r}`;
      const stackOnEnemyCastle = currentGrid.get(enemyCastleKey);
      
      setCaptureProgress(prev => {
        const newProgress = { ...prev };
        const playerKey = nextPlayer === 1 ? 'p1' : 'p2';
        
        if (stackOnEnemyCastle && stackOnEnemyCastle.owner === nextPlayer) {
          newProgress[playerKey] += 1;
          if (newProgress[playerKey] >= 3) {
            setWinner(nextPlayer);
            setWinMessage(`Player ${nextPlayer} wins by capturing the enemy fortress!`);
          }
        } else {
          newProgress[playerKey] = 0;
        }
        return newProgress;
      });
    }
  };

  const getCursorStyle = () => {
    if (isPanning) return 'grabbing';
    if (actionState === 'idle' && !selectedStack && hoveredHex) {
      const key = `${hoveredHex.q},${hoveredHex.r}`;
      if (!grid.has(key) && !currentFrontlineSet.has(key)) {
        return 'not-allowed';
      }
    }
    return 'default';
  };

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      className="relative w-screen h-[100dvh] overflow-hidden bg-slate-900"
      style={{
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <canvas
        {...bind()}
        ref={canvasRef}
        width={windowSize.width}
        height={windowSize.height}
        className="absolute inset-0 w-full h-full touch-none"
        style={{ 
          cursor: getCursorStyle(), 
          touchAction: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerLeave}
        onPointerLeave={handlePointerLeave}
      />

      {/* Action Menu Overlay */}
      {selectedStack && (actionState === 'idle' || actionState === 'special_menu') && (() => {
        const key = `${selectedStack.q},${selectedStack.r}`;
        const stack = grid.get(key);
        if (!stack) return null;

        const piece = PIECE_TYPES[stack.count] || PIECE_TYPES[1];
        const moveSpeed = stack.isKing && stack.count === 1 ? 4 : piece.move;
        const isImmobile = moveSpeed === 0;

        const maxCount = stack.isKing ? 6 : 5;
        const canFortify = !isImmobile && stack.count < maxCount && reserves[currentPlayer] > 0 && ap > 0 && !stack.isKing;
        const canMove = !isImmobile && ap > 0;
        const canCombine = !isImmobile && ap > 0 && !stack.isKing;
        const canAttack = !isImmobile && ap > 0;
        const isFort = terrainGrid.get(key)?.type === 'fort';
        const canSplinter = stack.count > 1 && !stack.isKing && isFort;
        const canCoordinatedStrikePlus = stack.isKing && stack.count < 5;
        const canCoordinatedStrike = stack.count === 3 || stack.count === 4 || canCoordinatedStrikePlus;
        const canSpecial = ap > 0 && (canCoordinatedStrike || canSplinter);

        const handleFortify = () => {
          if (!canFortify) return;
          saveHistory();
          const newGrid = new Map<string, Stack>(grid);
          const newCount = stack.count + 1;
          newGrid.set(key, { ...stack, count: newCount });
          setGrid(newGrid);
          if (newCount >= 5 || stack.isKing) {
            const newTerrainGrid = new Map(terrainGrid);
            newTerrainGrid.set(key, { type: 'fort' });
            setTerrainGrid(newTerrainGrid);
          }
          const newReserve = reserves[currentPlayer] - 1;
          setReserves(prev => ({ ...prev, [currentPlayer]: newReserve }));
          if (newReserve < minReserves[currentPlayer]) {
            setMinReserves(prev => ({ ...prev, [currentPlayer]: newReserve }));
            setStallTimers(prev => ({ ...prev, [currentPlayer]: STALL_TIMER_DEFAULT }));
          }
          setAp(prev => prev - 1);
          setSelectedStack(null);
        };

        const handleNotImplemented = (actionName: string) => {
          showToast(`${actionName} Action not yet implemented`);
        };

        return (
          <div 
            className="absolute z-20 bg-slate-800/95 backdrop-blur border border-slate-600 rounded-xl shadow-2xl p-2 flex flex-col gap-1 w-40 pointer-events-auto"
            style={{
              left: Math.min(windowSize.width - 170, Math.max(10, windowSize.width / 2 + camera.x + axialToPixel(selectedStack.q, selectedStack.r, HEX_SIZE).x * camera.zoom + 30)),
              top: Math.min(windowSize.height - 200, Math.max(10, windowSize.height / 2 + camera.y + axialToPixel(selectedStack.q, selectedStack.r, HEX_SIZE).y * camera.zoom - 60)),
            }}
          >
            <div className="text-[10px] text-slate-400 mb-1 px-2 uppercase font-bold tracking-wider">Actions</div>
            
            {actionState === 'special_menu' ? (
              <>
                {canCoordinatedStrike && (
                  <button 
                    onClick={() => {
                      // Highlight adjacent enemies
                      const enemies = new Set<string>();
                      for (const neighbor of getNeighbors(selectedStack.q, selectedStack.r)) {
                        const nKey = `${neighbor.q},${neighbor.r}`;
                        const nStack = grid.get(nKey);
                        if (nStack && nStack.owner !== currentPlayer) {
                          enemies.add(nKey);
                        }
                      }
                      if (enemies.size > 0) {
                        setHighlightedHexes(enemies);
                        setActionState('coordinated_strike_target');
                      } else {
                        showToast("No adjacent enemies for Coordinated Strike");
                        setActionState('idle');
                      }
                    }}
                    className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 transition-colors"
                  >
                    Coordinated Strike
                  </button>
                )}
                {canSplinter && (
                  <>
                    <button 
                      onClick={() => { setSplitAmount(1); setSplinterAction('move'); setActionState('splinter_select_amount'); }}
                      className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 transition-colors"
                    >
                      Split & Move
                    </button>
                    <button 
                      onClick={() => { setSplitAmount(1); setSplinterAction('combine'); setActionState('splinter_select_amount'); }}
                      className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 transition-colors"
                    >
                      Split & Combine
                    </button>
                    <button 
                      onClick={() => { setSplitAmount(1); setSplinterAction('attack'); setActionState('splinter_select_amount'); }}
                      className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 transition-colors"
                    >
                      Split & Attack
                    </button>
                  </>
                )}
                <button 
                  onClick={() => setActionState('idle')}
                  className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 transition-colors"
                >
                  Back
                </button>
              </>
            ) : (
              <>
                <button 
                  disabled={!canFortify} 
                  onClick={handleFortify}
                  className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                >
                  Fortify
                </button>
                <button 
                  disabled={!canMove} 
                  onClick={() => {
                    const reachable = getReachableHexes(selectedStack, moveSpeed, grid);
                    setHighlightedHexes(reachable.reachableEmpty);
                    setActionState('moving');
                  }}
                  className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                >
                  Move
                </button>
                <button 
                  disabled={!canCombine} 
                  onClick={() => {
                    const reachable = getReachableHexes(selectedStack, moveSpeed, grid);
                    setHighlightedHexes(reachable.reachableAllies);
                    setActionState('combining');
                  }}
                  className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                >
                  Combine
                </button>
                <button 
                  disabled={!canAttack} 
                  onClick={() => {
                    const reachable = getReachableHexes(selectedStack, moveSpeed, grid);
                    setHighlightedHexes(reachable.validEnemies);
                    setEntryHexesMap(reachable.entryHexesForEnemy);
                    setActionState('attacking_target');
                  }}
                  className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                >
                  Attack
                </button>
                <button 
                  disabled={!canSpecial} 
                  onClick={() => setActionState('special_menu')}
                  className="px-3 py-2 text-sm text-slate-200 text-left rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                >
                  Special
                </button>
              </>
            )}
          </div>
        );
      })()}

      {hoveredHex && grid.has(`${hoveredHex.q},${hoveredHex.r}`) && (
        <div className="absolute top-48 right-4 w-80 bg-slate-800/95 backdrop-blur border border-slate-700 rounded-xl shadow-2xl p-5 pointer-events-none transition-opacity z-10">
          {(() => {
            const stack = grid.get(`${hoveredHex.q},${hoveredHex.r}`)!;
            const piece = PIECE_TYPES[stack.count] || PIECE_TYPES[1];
            return (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    {stack.isKing ? <Crown size={18} className="text-amber-400" /> : <Info size={18} className="text-slate-400" />}
                    {stack.isKing ? PIECE_TYPES[6].name : piece.name}
                  </h3>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${stack.owner === 1 ? 'bg-blue-500/20 text-blue-300' : 'bg-red-500/20 text-red-300'}`}>
                    Player {stack.owner}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-300 text-sm">
                  <span className="font-semibold text-slate-400">Move Speed:</span>
                  <span className="bg-slate-700 px-2 py-0.5 rounded font-mono">{stack.isKing && stack.count === 1 ? 4 : piece.move}</span>
                </div>
                <div className="text-sm text-slate-300 leading-relaxed bg-slate-900/50 p-3 rounded-lg border border-slate-700/50">
                  <span className="font-semibold text-slate-400 block mb-1">Special Rule:</span>
                  {stack.isKing ? PIECE_TYPES[6].rule : piece.rule}
                </div>
                <div className="text-xs text-slate-500 mt-1 flex justify-between items-center">
                  <span>Stack Count</span>
                  <span className="font-mono bg-slate-800 px-2 py-1 rounded">{stack.count} / {stack.isKing ? 6 : 5}</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Battle Data Pop-up */}
      {actionState === 'attacking_target' && hoveredHex && highlightedHexes.has(`${hoveredHex.q},${hoveredHex.r}`) && selectedStack && (() => {
        const targetKey = `${hoveredHex.q},${hoveredHex.r}`;
        const attackerStack = activeSplinter ? activeSplinter.stack : grid.get(`${selectedStack.q},${selectedStack.r}`);
        const defenderStack = grid.get(targetKey);
        
        if (!attackerStack || !defenderStack) return null;

        const battleData = calculateBattlePower(attackerStack, defenderStack, hoveredHex, terrainGrid);
        const attackerPieceName = attackerStack.isKing ? PIECE_TYPES[6].name : (PIECE_TYPES[attackerStack.count] || PIECE_TYPES[1]).name;
        const defenderPieceName = defenderStack.isKing ? PIECE_TYPES[6].name : (PIECE_TYPES[defenderStack.count] || PIECE_TYPES[1]).name;

        return (
          <div 
            className="absolute z-30 bg-slate-900/95 backdrop-blur border border-red-500/50 rounded-lg shadow-xl p-3 pointer-events-none w-48"
            style={{ left: mousePos.x + 15, top: mousePos.y + 15 }}
          >
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 border-b border-slate-700 pb-1">Battle Data</div>
            
            <div className="flex justify-between items-center mb-1">
              <span className="text-blue-400 font-semibold text-sm truncate pr-2">{attackerPieceName} Damage Dealt</span>
              <span className="text-white font-mono font-bold">{battleData.finalAttackerPower}</span>
            </div>
            
            <div className="flex justify-between items-center mb-2">
              <span className="text-red-400 font-semibold text-sm truncate pr-2">{defenderPieceName} Health</span>
              <span className="text-white font-mono font-bold">{battleData.finalDefenderPower}</span>
            </div>
            
            <div className="text-[10px] text-slate-500 italic bg-slate-800/50 p-1.5 rounded">
              Mods: {battleData.breakdown}
            </div>
          </div>
        );
      })()}

      <div className="absolute top-0 left-0 right-0 p-4 pointer-events-none flex justify-between items-start z-10">
        {/* Player 1 Stats */}
        <div className={`bg-slate-800/90 backdrop-blur p-4 rounded-xl border shadow-xl w-64 pointer-events-auto transition-colors ${currentPlayer === 1 ? 'border-blue-500 shadow-blue-900/20' : 'border-slate-700'}`}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-blue-400 font-bold">Player 1</span>
            <span className="text-slate-300 text-sm font-mono">Board: {boardCount[1]}</span>
          </div>
          <div className="flex items-center gap-2 text-slate-200 mb-2">
            <Coins size={16} className="text-blue-400" />
            <span className="font-mono w-6 text-right">{reserves[1]}</span>
            <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${(reserves[1] / STARTING_RESERVES) * 100}%` }} />
            </div>
          </div>
          {stallTimerInfoVisible && (
            <div className="flex flex-col gap-1 text-xs text-slate-400 mt-2 border-t border-slate-700 pt-2">
              <div className="flex justify-between items-center">
                <span>Stall Timer: <span className={`font-mono font-bold ${stallTimers[1] <= 1 ? 'text-red-400' : 'text-slate-200'}`}>{stallTimers[1]}</span></span>
                <span>Min Total: <span className="font-mono">{minTotalUnits[1]}</span></span>
              </div>
              <div className="flex justify-end items-center">
                <span>Min Reserve: <span className="font-mono">{minReserves[1]}</span></span>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-2 pointer-events-auto">
          {(() => {
            const minTimer = Math.min(stallTimers[1], stallTimers[2]);
            if (minTimer === 0) {
              return (
                <div className="bg-red-900/90 border border-red-500 text-red-100 px-6 py-2 rounded-full font-bold shadow-lg flex items-center gap-2 animate-pulse">
                  <Skull size={18} />
                  STALL DETECTED
                </div>
              );
            } else if (minTimer <= 3) {
              return (
                <div className="bg-amber-900/90 border border-amber-500 text-amber-100 px-6 py-2 rounded-full font-bold shadow-lg flex items-center gap-2">
                  <AlertTriangle size={18} />
                  STALL IMMINENT
                </div>
              );
            }
            return null;
          })()}
        </div>

        {/* Player 2 Stats */}
        <div className={`bg-slate-800/90 backdrop-blur p-4 rounded-xl border shadow-xl w-64 pointer-events-auto transition-colors ${currentPlayer === 2 ? 'border-red-500 shadow-red-900/20' : 'border-slate-700'}`}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-red-400 font-bold">Player 2</span>
            <span className="text-slate-300 text-sm font-mono">Board: {boardCount[2]}</span>
          </div>
          <div className="flex items-center gap-2 text-slate-200 mb-2">
            <Coins size={16} className="text-red-400" />
            <span className="font-mono w-6 text-right">{reserves[2]}</span>
            <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-red-500 transition-all" style={{ width: `${(reserves[2] / STARTING_RESERVES) * 100}%` }} />
            </div>
          </div>
          {stallTimerInfoVisible && (
            <div className="flex flex-col gap-1 text-xs text-slate-400 mt-2 border-t border-slate-700 pt-2">
              <div className="flex justify-between items-center">
                <span>Stall Timer: <span className={`font-mono font-bold ${stallTimers[2] <= 1 ? 'text-red-400' : 'text-slate-200'}`}>{stallTimers[2]}</span></span>
                <span>Min Total: <span className="font-mono">{minTotalUnits[2]}</span></span>
              </div>
              <div className="flex justify-end items-center">
                <span>Min Reserve: <span className="font-mono">{minReserves[2]}</span></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-6 pointer-events-none flex justify-center items-end gap-4 z-10">
        <div className="bg-slate-800/90 backdrop-blur p-4 rounded-2xl shadow-xl pointer-events-auto flex flex-col items-center gap-4 border border-slate-700">
          <div className="flex items-center gap-6">
            <div className="text-slate-200 font-semibold flex items-center gap-2">
              Current Turn:
              <span
                className={`px-3 py-1 rounded-full text-white text-sm ${
                  currentPlayer === 1 ? 'bg-blue-500' : 'bg-red-500'
                }`}
              >
                Player {currentPlayer}
              </span>
            </div>
            
            <div className="h-8 w-px bg-slate-700"></div>
            
            <button
              onClick={() => setShowBothFrontlines(!showBothFrontlines)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium ${
                showBothFrontlines 
                  ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30' 
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
              title="Toggle Opponent Frontline"
            >
              {showBothFrontlines ? <Eye size={16} /> : <EyeOff size={16} />}
              <span className="hidden sm:inline">All Frontlines</span>
            </button>

            <div className="h-8 w-px bg-slate-700"></div>
            
            <div className="flex items-center gap-2 text-amber-400 font-bold">
              <Zap size={20} className={ap > 0 ? 'fill-amber-400' : 'opacity-50'} />
              <span className="text-xl">{ap} AP</span>
            </div>
          </div>
          {actionState === 'idle' && !selectedStack && (
            <div className="flex gap-3 w-full">
              <button
                onClick={handleUndo}
                disabled={history.length === 0 || winner !== null}
                className="flex-1 flex justify-center items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:hover:bg-slate-700 text-white rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                <Undo size={18} /> Undo
              </button>
              <button
                onClick={handleConfirm}
                disabled={winner !== null}
                className="flex-1 flex justify-center items-center gap-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600 text-white rounded-lg font-medium transition-colors shadow-lg shadow-emerald-900/20 cursor-pointer disabled:cursor-not-allowed"
              >
                <Check size={18} /> Confirm Turn
              </button>
            </div>
          )}
          <div className="text-xs text-slate-400/80 font-medium text-center mt-1">
            right-click & drag to pan • scroll to zoom • left-click to place/select
          </div>
        </div>
      </div>
      {/* Popups */}
      {popupState && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-600 p-6 rounded-xl shadow-2xl max-w-md w-full">
            {popupState.type === 'combine_limit' && (
              <>
                <h3 className="text-xl font-bold text-white mb-4">Stack Limit Reached</h3>
                <p className="text-slate-300 mb-6">
                  {popupState.excess} pieces will be returned to your Reserve.
                </p>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => {
                      setPopupState(null);
                      setActionState('idle');
                      setSelectedStack(null);
                      setHighlightedHexes(new Set());
                      setActiveSplinter(null);
                    }}
                    className="px-4 py-2 rounded-lg font-medium text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer"
                  >
                    Undo
                  </button>
                  <button 
                    onClick={() => {
                      saveHistory();
                      const newGrid = new Map<string, Stack>(grid);
                      const sourceStack = popupState.splinter ? popupState.splinter.stack : newGrid.get(popupState.sourceKey)!;
                      const targetStack = newGrid.get(popupState.targetKey)!;
                      const isKing = sourceStack.isKing || targetStack.isKing;
                      
                      if (popupState.splinter) {
                        const originalSource = newGrid.get(popupState.splinter.sourceKey)!;
                        newGrid.set(popupState.splinter.sourceKey, { ...originalSource, count: originalSource.count - popupState.splinter.stack.count });
                      } else {
                        newGrid.delete(popupState.sourceKey);
                      }
                      newGrid.set(popupState.targetKey, { ...targetStack, count: isKing ? 6 : 5, isKing });
                      if (isKing) {
                        const [qStr, rStr] = popupState.targetKey.split(',');
                        setKingPos(prev => ({ ...prev, [sourceStack.owner === 1 ? 'p1' : 'p2']: { q: parseInt(qStr), r: parseInt(rStr) } }));
                      }
                      
                      setGrid(newGrid);
                      const newTerrainGrid = new Map(terrainGrid);
                      newTerrainGrid.set(popupState.targetKey, { type: 'fort' });
                      setTerrainGrid(newTerrainGrid);
                      setReserves(prev => ({ ...prev, [currentPlayer]: prev[currentPlayer] + popupState.excess }));
                      setAp(prev => prev - 1);
                      
                      setPopupState(null);
                      setActionState('idle');
                      setSelectedStack(null);
                      setHighlightedHexes(new Set());
                      setActiveSplinter(null);
                    }}
                    className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Confirm
                  </button>
                </div>
              </>
            )}
            
            {popupState.type === 'combat_report' && (
              <>
                <h3 className="text-xl font-bold text-white mb-4">Battle Report</h3>
                <div className="text-slate-300 mb-6 space-y-2">
                  <p>
                    <span className={`font-semibold ${popupState.attackerOwner === 1 ? 'text-blue-400' : 'text-red-400'}`}>Attacker (Player {popupState.attackerOwner}):</span> {popupState.attackerStart} → {popupState.attackerRemaining}
                  </p>
                  <p>
                    <span className={`font-semibold ${popupState.defenderOwner === 1 ? 'text-blue-400' : 'text-red-400'}`}>Defender (Player {popupState.defenderOwner}):</span> {popupState.defenderStart} → {popupState.defenderRemaining}
                  </p>
                  <p className="mt-4 font-bold text-lg text-white">
                    {popupState.defenderRemaining === 0 && popupState.attackerRemaining > 0 ? 'Victory!' : 
                     popupState.attackerRemaining === 0 && popupState.defenderRemaining > 0 ? 'Defeat!' : 
                     'Mutual Annihilation!'}
                  </p>
                </div>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => {
                      const salvageState: Extract<PopupState, { type: 'combat_salvage' }> = {
                        type: 'combat_salvage',
                        attackerKey: popupState.attackerKey,
                        defenderKey: popupState.defenderKey,
                        entryKey: popupState.entryKey,
                        attackerRemaining: popupState.attackerRemaining,
                        defenderRemaining: popupState.defenderRemaining,
                        splinter: popupState.splinter
                      };
                      
                      if (popupState.attackerStart === 1) {
                        handleCombatResolution(false, salvageState);
                      } else if (popupState.attackerStart === 2 && popupState.attackerRemaining >= 2) {
                        handleCombatResolution(false, salvageState);
                      } else {
                        setPopupState(salvageState);
                      }
                    }}
                    className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Confirm
                  </button>
                </div>
              </>
            )}

            {popupState.type === 'combat_salvage' && (
              <>
                <h3 className="text-xl font-bold text-white mb-4">Combat Concluded</h3>
                <p className="text-slate-300 mb-6">
                  Return 1 discarded piece to Reserve?
                </p>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => {
                      handleCombatResolution(false, popupState);
                    }}
                    className="px-4 py-2 rounded-lg font-medium text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer"
                  >
                    Deny
                  </button>
                  <button 
                    onClick={() => {
                      handleCombatResolution(true, popupState);
                    }}
                    className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Confirm
                  </button>
                </div>
              </>
            )}

            {popupState.type === 'combat_advance' && (
              <>
                <h3 className="text-xl font-bold text-white mb-4">Enemy Defeated</h3>
                <p className="text-slate-300 mb-6">
                  Advance to the defender's hex?
                </p>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => {
                      handleAdvanceResolution(false, popupState);
                    }}
                    className="px-4 py-2 rounded-lg font-medium text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer"
                  >
                    Stay Put
                  </button>
                  <button 
                    onClick={() => {
                      handleAdvanceResolution(true, popupState);
                    }}
                    className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Advance
                  </button>
                </div>
              </>
            )}

            {popupState.type === 'coordinated_strike_report' && (
              <>
                <h3 className="text-xl font-bold text-white mb-4">Coordinated Strike Report</h3>
                <div className="text-slate-300 mb-6 space-y-2">
                  <div className="mb-4">
                    <span className={`font-semibold ${popupState.defenderOwner === 1 ? 'text-blue-400' : 'text-red-400'}`}>Defender (Player {popupState.defenderOwner}):</span> {popupState.defenderStart} → {popupState.defenderRemaining}
                  </div>
                  <div className="space-y-1">
                    <span className={`font-semibold ${popupState.attackerOwner === 1 ? 'text-blue-400' : 'text-red-400'}`}>Attackers (Player {popupState.attackerOwner}):</span>
                    {popupState.participants.map((p, i) => (
                      <div key={p.key} className="pl-4 text-sm">
                        Army {i + 1} {p.key === popupState.primaryAttackerKey ? '(Primary)' : ''}: {p.startCount} → {p.remainingCount}
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 font-bold text-lg text-white">
                    {popupState.defenderRemaining === 0 ? 'Victory!' : 
                     popupState.participants.every(p => p.remainingCount === 0) ? 'Defeat!' : 
                     'Stalemate!'}
                  </p>
                </div>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => handleCoordinatedStrikeReport(popupState)}
                    className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Continue
                  </button>
                </div>
              </>
            )}

            {popupState.type === 'coordinated_strike_salvage' && (() => {
              // We need local state for the toggles. We can use a simple component or just manage it here if we add a state variable, but since we can't easily add a hook inside this render block, let's create a small wrapper component or just use a form.
              // Actually, we can just use a form with checkboxes.
              return (
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const selections: Record<string, boolean> = {};
                  popupState.participants.forEach(p => {
                    selections[p.key] = formData.get(`salvage_${p.key}`) === 'on';
                  });
                  handleCoordinatedStrikeSalvage(selections, popupState);
                }}>
                  <h3 className="text-xl font-bold text-white mb-4">Multi-Salvage</h3>
                  <p className="text-slate-300 mb-4 text-sm">
                    Select armies to salvage (adds 1 to reserves per salvaged army).
                  </p>
                  <div className="space-y-3 mb-6 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                    {popupState.participants.map((p, i) => {
                      const isDamaged = p.remainingCount < p.startCount;
                      return (
                        <div key={p.key} className={`flex items-center justify-between p-2 rounded border ${isDamaged ? 'bg-slate-800 border-slate-600' : 'bg-slate-800/50 border-slate-700/50 opacity-60'}`}>
                          <div>
                            <div className="text-sm font-medium text-slate-200">Army {i + 1} {p.key === popupState.primaryAttackerKey ? '(Primary)' : ''}</div>
                            <div className="text-xs text-slate-400">Remaining: {p.remainingCount}</div>
                          </div>
                          <label className="flex items-center cursor-pointer">
                            <input 
                              type="checkbox" 
                              name={`salvage_${p.key}`}
                              disabled={!isDamaged}
                              className="sr-only peer"
                            />
                            <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 relative"></div>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-end gap-3">
                    <button 
                      type="submit"
                      className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                    >
                      Confirm Salvage
                    </button>
                  </div>
                </form>
              );
            })()}

            {popupState.type === 'coordinated_strike_advance' && (
              <>
                <h3 className="text-xl font-bold text-white mb-4">Enemy Defeated</h3>
                <p className="text-slate-300 mb-6">
                  Advance the Primary Attacking Army to the defender's hex?
                </p>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => handleCoordinatedStrikeAdvance(false, popupState)}
                    className="px-4 py-2 rounded-lg font-medium text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer"
                  >
                    Stay Put
                  </button>
                  <button 
                    onClick={() => handleCoordinatedStrikeAdvance(true, popupState)}
                    className="px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    Advance Primary
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* War Room Pop-up */}
      {actionState === 'coordinated_strike_select_allies' && attackTarget && selectedStack && (() => {
        const targetKey = `${attackTarget.q},${attackTarget.r}`;
        const targetStack = grid.get(targetKey);
        if (!targetStack) return null;

        let rawAttackerPower = 0;
        strikeAllies.forEach(key => {
          const stack = grid.get(key);
          if (stack) rawAttackerPower += stack.count;
        });
        
        const isFort = terrainGrid.get(targetKey)?.type === 'fort';
        const attackerPower = isFort && rawAttackerPower > 0 ? rawAttackerPower - 1 : rawAttackerPower;
        const defenderPower = targetStack.count;

        return (
          <div className="absolute top-[116px] left-4 w-96 bg-slate-900/95 backdrop-blur border border-red-500/50 rounded-xl shadow-2xl p-5 z-20 flex flex-col gap-4">
            <div className="text-sm font-bold text-slate-300 uppercase tracking-wider border-b border-slate-700 pb-2 flex items-center justify-between">
              <span>War Room</span>
              <span className="text-red-400 text-xs">Coordinated Strike</span>
            </div>
            
            <div className="flex flex-col gap-2">
              <div className="text-xs text-slate-400 font-semibold uppercase">Target</div>
              <div className="flex justify-between items-center bg-slate-800 p-2 rounded border border-slate-700">
                <span className="text-slate-200">{targetStack.isKing ? PIECE_TYPES[6].name : PIECE_TYPES[targetStack.count]?.name || 'Unknown'}</span>
                <span className="text-red-400 font-mono font-bold">Count: {targetStack.count}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-xs text-slate-400 font-semibold uppercase">Participating Armies</div>
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                {strikeAllies.map((key, index) => {
                  const stack = grid.get(key);
                  if (!stack) return null;
                  const isPrimary = key === `${selectedStack.q},${selectedStack.r}`;
                  return (
                    <div 
                      key={key} 
                      data-ally-index={index}
                      onPointerDown={(e) => {
                        e.preventDefault(); // Prevent text selection
                        setDraggedAllyIndex(index);
                      }}
                      onMouseEnter={() => setHoveredAllyKey(key)}
                      onMouseLeave={() => setHoveredAllyKey(null)}
                      className={`flex justify-between items-center p-2 rounded border cursor-grab active:cursor-grabbing transition-all touch-none select-none 
                        ${isPrimary ? 'bg-maroon-900/30 border-maroon-500/50' : 'bg-slate-800 border-slate-700'} 
                        ${draggedAllyIndex === index ? 'opacity-50 scale-95' : 'opacity-100'}`}
                      style={isPrimary ? { backgroundColor: 'rgba(128, 0, 0, 0.2)', borderColor: 'rgba(128, 0, 0, 0.5)' } : {}}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-slate-200">{stack.isKing ? PIECE_TYPES[6].name : PIECE_TYPES[stack.count]?.name || 'Unknown'}</span>
                        {isPrimary && <span className="text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded uppercase font-bold">Primary</span>}
                        {index === 0 && <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded uppercase font-bold">Breach</span>}
                      </div>
                      <span className="text-blue-400 font-mono font-bold">Count: {stack.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2 mt-2">
              <div className="text-xs text-slate-400 font-semibold uppercase">Battle Forecast</div>
              <div key={strikeAllies.join('-')} className="bg-slate-800 p-3 rounded border border-slate-700 flex justify-between items-center animate-[pulse_0.3s_ease-in-out_1]">
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">Attacker</span>
                  <span className="text-3xl font-bold text-blue-400">{attackerPower}</span>
                </div>
                <div className="text-slate-500 font-bold text-xl italic">VS</div>
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">Defender</span>
                  <span className="text-3xl font-bold text-red-400">{defenderPower}</span>
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-2">
              <button
                onClick={() => {
                  setActionState('idle');
                  setSelectedStack(null);
                  setStrikeAllies([]);
                  setPotentialStrikeAllies(new Set());
                  setAttackTarget(null);
                }}
                className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const primaryKey = `${selectedStack.q},${selectedStack.r}`;
                  const participantKeys = [...strikeAllies];
                  const targetKey = `${attackTarget.q},${attackTarget.r}`;
                  const targetStack = grid.get(targetKey)!;
                  const isFort = terrainGrid.get(targetKey)?.type === 'fort';
                  
                  let defenderRemaining = targetStack.count;
                  const participants = participantKeys.map(key => ({
                    key,
                    startCount: grid.get(key)!.count,
                    remainingCount: grid.get(key)!.count
                  }));

                  let startIndex = 0

                  if (isFort && participants.length > 0) {
                    participants[0].remainingCount = Math.max(0, participants[0].remainingCount - 1);

                    if (participants.length > 1) {
                      startIndex = 1;
                    }
                  }

                  let allParticipantsZero = false;
                  while (defenderRemaining > 0 && !allParticipantsZero) {
                    let anyParticipantAttacked = false;
                    for (let i = startIndex; i < participants.length; i++) {
                      const participant = participants[i];
                      if (defenderRemaining <= 0) break;
                      if (participant.remainingCount > 0) {
                        participant.remainingCount -= 1;
                        defenderRemaining -= 1;
                        anyParticipantAttacked = true;
                      }
                    }

                    startIndex = 0;

                    if (!anyParticipantAttacked) {
                      allParticipantsZero = true;
                    }
                  }

                  saveHistory();
                  setPopupState({
                    type: 'coordinated_strike_report',
                    targetKey,
                    primaryAttackerKey: primaryKey,
                    participants,
                    defenderStart: targetStack.count,
                    defenderRemaining,
                    defenderOwner: targetStack.owner,
                    attackerOwner: currentPlayer
                  });
                  
                  setActionState('idle');
                  setSelectedStack(null);
                  setStrikeAllies([]);
                  setPotentialStrikeAllies(new Set());
                  setAttackTarget(null);
                }}
                className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors text-sm font-medium shadow-lg shadow-red-900/20"
              >
                Confirm Strike
              </button>
            </div>
          </div>
        );
      })()}

      {/* Splinter Amount Select Modal */}
      {actionState === 'splinter_select_amount' && selectedStack && (() => {
        const stack = grid.get(`${selectedStack.q},${selectedStack.r}`);
        if (!stack) return null;
        
        const splinterStack = { ...stack, count: splitAmount };
        const piece = PIECE_TYPES[splinterStack.count] || PIECE_TYPES[1];

        return (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => { setActionState('idle'); setSplinterAction(null); }}>
            <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-96 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
              <div className="text-lg font-bold text-slate-200 border-b border-slate-700 pb-2">
                Splinter Army
              </div>
              
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-400">Split Amount</span>
                  <span className="text-lg font-bold text-blue-400">{splitAmount}</span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max={stack.count - 1} 
                  value={splitAmount} 
                  onChange={(e) => setSplitAmount(parseInt(e.target.value, 10))}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>1</span>
                  <span>{stack.count - 1}</span>
                </div>
              </div>

              <div className="bg-slate-800 p-3 rounded border border-slate-700 flex flex-col gap-2">
                <div className="text-xs text-slate-400 font-semibold uppercase">Splinter Unit Stats</div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-medium">{piece.name}</span>
                  <span className="text-slate-400 text-sm">Move: {piece.move}</span>
                </div>
                {piece.rule && (
                  <div className="text-xs text-slate-500 italic">
                    {piece.rule}
                  </div>
                )}
              </div>

              <div className="flex gap-2 mt-2">
                <button 
                  onClick={() => { setActionState('idle'); setSplinterAction(null); }}
                  className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    const sourceKey = `${selectedStack.q},${selectedStack.r}`;
                    const sourceStack = grid.get(sourceKey)!;
                    const splinterStack = { ...sourceStack, count: splitAmount };
                    setActiveSplinter({
                      sourceKey,
                      stack: splinterStack
                    });
                    
                    const tempGrid = new Map<string, Stack>(grid);
                    tempGrid.set(sourceKey, splinterStack);
                    
                    const piece = PIECE_TYPES[splitAmount] || PIECE_TYPES[1];
                    const moveSpeed = piece.move;
                    
                    const reachable = getReachableHexes(selectedStack, moveSpeed, tempGrid);
                    
                    if (splinterAction === 'move') {
                      setActionState('moving');
                      setHighlightedHexes(reachable.reachableEmpty);
                    } else if (splinterAction === 'combine') {
                      setActionState('combining');
                      setHighlightedHexes(reachable.reachableAllies);
                    } else if (splinterAction === 'attack') {
                      setActionState('attacking_target');
                      setHighlightedHexes(reachable.validEnemies);
                      setEntryHexesMap(reachable.entryHexesForEnemy);
                    }
                    
                    setSplinterAction(null);
                    setSplitAmount(1);
                  }}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Game Over Overlay */}
      {winner && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-600 rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-6 max-w-md text-center">
            <h2 className="text-4xl font-black text-white uppercase tracking-widest drop-shadow-md">
              Game Over
            </h2>
            <p className="text-xl text-slate-300 font-medium">
              {winMessage}
            </p>
            <button
              onClick={() => {
                window.location.reload();
              }}
              className="mt-4 px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-lg transition-all active:scale-95 uppercase tracking-wider"
            >
              Play Again
            </button>
          </div>
        </div>
      )}

      {/* Toast Message */}
      {toastMessage && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-4 py-2 rounded-full shadow-lg border border-slate-600 z-50 transition-opacity duration-300">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
