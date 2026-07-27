// Shared optical-budget chain math for the topology map (ClientsMap) and the
// Tech Tools "Topology dBm Lookup" — kept in one place so both views compute
// received power the same way.

export interface ChainNapLike {
  id: number;
  name: string;
  kind: string;
  parentId: number | null;
  splitterType?: string | null;
  splitterRatio?: string | null;
  /** Cassette/split port count — only affects the lookup for FBTC (see refKey). */
  ports?: number | null;
  /**
   * Which leg this NAP draws from — of its parent NAP's splitter (default
   * path), or of its origin splitter when `originSplitterId` is set. 'through'
   * (trunk continue, the default) or 'tap' (subscriber drop). Only meaningful
   * when that origin is FBTC-typed; ignored otherwise.
   */
  fbtcLeg?: 'through' | 'tap' | null;
  /**
   * When set, this NAP's origin is a standalone splitter (see SplitterLike)
   * instead of its OLT/NAP parent (parentId) — a splitter can sit between an
   * OLT/NAP and several downstream NAP boxes, dividing the signal before any
   * of them see it.
   */
  originSplitterId?: number | null;
  txDbm?: number | null;
}

export interface SplitterRefLike {
  type: string;
  ratio: string;
  /** Cassette tray size — only meaningful (and only part of the lookup key) for FBTC. */
  ports?: number | null;
  throughLossDb: number;
  tapLossDb?: number | null;
}

/** A standalone splitter unit — its own origin (OLT/NAP/another splitter), managed independently of any NAP box. */
export interface SplitterLike {
  id: number;
  name: string;
  type: 'FBT' | 'PLC' | 'FBTC';
  ratio: string;
  ports?: number | null;
  originKind: 'olt' | 'nap' | 'splitter';
  originId: number | null;
  /** Which leg of ITS OWN origin (if that origin is FBTC-typed) this splitter draws from. */
  fbtcLeg?: 'through' | 'tap' | null;
}

/**
 * FBT and FBTC are both asymmetric tap-percentage couplers (95:5, 90:10, ...,
 * 50:50) with a through leg (trunk continue) and a tap leg (subscriber drop)
 * — FBTC is just a cassette cascading several FBT couplers in one tray. PLC
 * is the only symmetric type (equal N-way split, no tap leg).
 */
export function isAsymmetricType(type?: string | null): boolean {
  return type === 'FBTC' || type === 'FBT';
}

/**
 * FBTC loss scales with cassette size (an 8/16/32-port tray cascades that many
 * individual tap couplers internally, so the cumulative through-loss and the
 * worst-case tap-loss both grow with port count) — so its lookup key includes
 * ports. FBT is a bare/single coupler (no cassette to scale by) and PLC is a
 * symmetric splitter where ratio alone determines the loss, so both keep a
 * type+ratio key (a NAP's "capacity" field isn't necessarily the same number
 * as the split count, and shouldn't affect the lookup for those types).
 */
function refKey(type?: string | null, ratio?: string | null, ports?: number | null): string {
  if (!type || !ratio) return '';
  return type === 'FBTC' ? `${type}|${ratio}|${ports ?? ''}` : `${type}|${ratio}`;
}

function buildLossMaps(splitterRows: SplitterRefLike[]) {
  const throughMap = new Map(splitterRows.map((r) => [refKey(r.type, r.ratio, r.ports), r.throughLossDb]));
  const tapMap = new Map(
    splitterRows.filter((r) => r.tapLossDb != null).map((r) => [refKey(r.type, r.ratio, r.ports), r.tapLossDb as number])
  );
  return { throughMap, tapMap };
}

/** The dBm at one output leg of a splitter, given the power arriving at its input. Null if no reference match. */
function splitterLegOutput(
  s: SplitterLike,
  inputDbm: number,
  leg: 'through' | 'tap' | null | undefined,
  splitterRows: SplitterRefLike[]
): number | null {
  const { throughMap, tapMap } = buildLossMaps(splitterRows);
  const key = refKey(s.type, s.ratio, s.ports);
  if (!key) return null;
  const wantTap = isAsymmetricType(s.type) && leg === 'tap';
  const loss = wantTap ? tapMap.get(key) : throughMap.get(key);
  return loss != null ? inputDbm - loss : null;
}

/** Power arriving at a splitter's own input, resolved recursively through its origin (OLT / NAP / another splitter). */
export function resolveSplitterInputDbm(
  splitterId: number,
  splittersById: Map<number, SplitterLike>,
  napsById: Map<number, ChainNapLike>,
  splitterRows: SplitterRefLike[],
  visited: Set<number> = new Set()
): number | null {
  const s = splittersById.get(splitterId);
  if (!s || visited.has(splitterId)) return null; // missing or cyclic origin chain
  visited.add(splitterId);
  if (s.originKind === 'olt') {
    const olt = s.originId != null ? napsById.get(s.originId) : undefined;
    return olt?.txDbm != null ? Number(olt.txDbm) : DEFAULT_ORIGIN_DBM;
  }
  if (s.originKind === 'nap') {
    if (s.originId == null) return null;
    const result = computeNapChainDbm(s.originId, napsById, splitterRows, splittersById);
    return result ? result.receivedDbm : null;
  }
  if (s.originKind === 'splitter') {
    if (s.originId == null) return null;
    const parent = splittersById.get(s.originId);
    const parentInput = resolveSplitterInputDbm(s.originId, splittersById, napsById, splitterRows, visited);
    if (!parent || parentInput == null) return null;
    return splitterLegOutput(parent, parentInput, s.fbtcLeg, splitterRows);
  }
  return null;
}

export interface ChainStage {
  napId: number;
  name: string;
  splitterType?: string | null;
  splitterRatio?: string | null;
  /** Which leg's loss was applied — only meaningful for FBT/FBTC (asymmetric tap couplers). */
  leg: 'through' | 'tap';
  lossDb: number | null;
  after: number;
}

export interface ChainResult {
  oltId: number | null;
  oltName: string | null;
  originDbm: number;
  stages: ChainStage[];
  receivedDbm: number;
}

export const DEFAULT_ORIGIN_DBM = 5;

/**
 * Walks a NAP's parent chain up to its OLT (or up to a standalone splitter
 * origin, if `originSplitterId` is set on the bottom-most NAP), subtracting
 * each hop's splitter loss. For an FBT/FBTC (asymmetric tap coupler) ancestor
 * that feeds the next NAP in the chain, the loss applied is whichever leg
 * *that child* selects via its own `fbtcLeg` — 'through' (trunk continue, the
 * default) or 'tap' (subscriber drop, for a NAP deliberately cascaded off a
 * tap port instead). The terminal NAP itself — i.e. whichever NAP's own
 * directly-attached clients this call is answering "what do they receive"
 * for — always draws from its own tap leg when it's FBT/FBTC, since that's
 * what a subscriber port is. PLC (symmetric splitter) always uses its single
 * per-leg loss value regardless of position.
 */
export function computeNapChainDbm(
  napId: number,
  napsById: Map<number, ChainNapLike>,
  splitterRows: SplitterRefLike[],
  splittersById?: Map<number, SplitterLike>
): ChainResult | null {
  const { throughMap, tapMap } = buildLossMaps(splitterRows);
  const chain: ChainNapLike[] = [];
  let cur: ChainNapLike | undefined = napsById.get(napId);
  if (!cur) return null;

  let originDbm = DEFAULT_ORIGIN_DBM;
  let oltId: number | null = null;
  let oltName: string | null = null;
  let root: ChainNapLike | undefined = cur;
  while (root && root.kind === 'nap') {
    chain.unshift(root);
    if (root.originSplitterId != null && splittersById) {
      const splitter = splittersById.get(root.originSplitterId);
      if (splitter) {
        const inputDbm = resolveSplitterInputDbm(splitter.id, splittersById, napsById, splitterRows);
        originDbm = inputDbm != null ? (splitterLegOutput(splitter, inputDbm, root.fbtcLeg, splitterRows) ?? DEFAULT_ORIGIN_DBM) : DEFAULT_ORIGIN_DBM;
        oltName = `${splitter.name} (splitter)`;
      }
      root = undefined;
      break;
    }
    root = root.parentId != null ? napsById.get(root.parentId) : undefined;
  }
  if (root && root.kind === 'olt') {
    oltId = root.id;
    oltName = root.name;
    originDbm = root.txDbm != null ? Number(root.txDbm) : DEFAULT_ORIGIN_DBM;
  }

  let running = originDbm;
  const stages: ChainStage[] = chain.map((n, i) => {
    const isTerminal = i === chain.length - 1;
    const child = isTerminal ? null : chain[i + 1];
    const wantsTap = isTerminal ? true : (child?.fbtcLeg ?? 'through') === 'tap';
    const key = refKey(n.splitterType, n.splitterRatio, n.ports);
    const useTap = isAsymmetricType(n.splitterType) && wantsTap && key !== '' && tapMap.has(key);
    const lossDb = key
      ? useTap
        ? (tapMap.get(key) as number)
        : throughMap.has(key)
          ? (throughMap.get(key) as number)
          : null
      : null;
    if (lossDb != null) running -= lossDb;
    return {
      napId: n.id,
      name: n.name,
      splitterType: n.splitterType,
      splitterRatio: n.splitterRatio,
      leg: useTap ? 'tap' : 'through',
      lossDb,
      after: running,
    };
  });

  return { oltId, oltName, originDbm, stages, receivedDbm: running };
}
