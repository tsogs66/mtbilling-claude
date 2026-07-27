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
   * Which leg of the PARENT's splitter this NAP is plugged into — 'through'
   * (trunk continue, the default) or 'tap' (subscriber drop, for a NAP
   * deliberately cascaded off a tap port instead). Only meaningful when the
   * parent's splitterType is 'FBTC'; ignored otherwise.
   */
  fbtcLeg?: 'through' | 'tap' | null;
  /**
   * Optional secondary FBT/PLC splitter fitted inside this NAP box, further
   * dividing this NAP's own local output — separate from (and applied after)
   * the box's own primary splitterType/splitterRatio. Only applies to this
   * NAP's own directly-attached clients, not to anything cascaded further
   * downstream via another NAP.
   */
  secondarySplitterType?: 'FBT' | 'PLC' | null;
  secondarySplitterRatio?: string | null;
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

/**
 * FBTC loss scales with cassette size (an 8/16/32-port tray cascades that many
 * individual tap couplers internally, so the cumulative through-loss and the
 * worst-case tap-loss both grow with port count) — so its lookup key includes
 * ports. FBT/PLC are single symmetric splitters where ratio alone determines
 * the loss, so their key stays type+ratio (a NAP's "capacity" field isn't
 * necessarily the same number as the split count, and shouldn't affect the
 * lookup for those types).
 */
function refKey(type?: string | null, ratio?: string | null, ports?: number | null): string {
  if (!type || !ratio) return '';
  return type === 'FBTC' ? `${type}|${ratio}|${ports ?? ''}` : `${type}|${ratio}`;
}

export interface ChainStage {
  napId: number;
  name: string;
  splitterType?: string | null;
  splitterRatio?: string | null;
  /** Which leg's loss was applied — only meaningful for FBTC (asymmetric tap cassette). */
  leg: 'through' | 'tap';
  lossDb: number | null;
  after: number;
  /** True for the synthetic stage representing a NAP's secondary in-box splitter. */
  secondary?: boolean;
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
 * Walks a NAP's parent chain up to its OLT, subtracting each hop's splitter
 * loss. For an FBTC (asymmetric tap cassette) ancestor that feeds the next
 * NAP in the chain, the loss applied is whichever leg *that child* selects
 * via its own `fbtcLeg` — 'through' (trunk continue, the default) or 'tap'
 * (subscriber drop, for a NAP deliberately cascaded off a tap port instead).
 * The terminal NAP itself — i.e. whichever NAP's own directly-attached
 * clients this call is answering "what do they receive" for — always draws
 * from its own tap ports when it's FBTC, since that's what a subscriber
 * port is. FBT/PLC (symmetric splitters) always use the single per-leg loss
 * value regardless of position.
 */
export function computeNapChainDbm(
  napId: number,
  napsById: Map<number, ChainNapLike>,
  splitterRows: SplitterRefLike[]
): ChainResult | null {
  const throughMap = new Map(splitterRows.map((r) => [refKey(r.type, r.ratio, r.ports), r.throughLossDb]));
  const tapMap = new Map(
    splitterRows.filter((r) => r.tapLossDb != null).map((r) => [refKey(r.type, r.ratio, r.ports), r.tapLossDb as number])
  );
  const chain: ChainNapLike[] = [];
  let cur: ChainNapLike | undefined = napsById.get(napId);
  if (!cur) return null;
  while (cur && cur.kind === 'nap') {
    chain.unshift(cur);
    cur = cur.parentId != null ? napsById.get(cur.parentId) : undefined;
  }
  const olt = cur && cur.kind === 'olt' ? cur : null;
  const originDbm = olt?.txDbm != null ? Number(olt.txDbm) : DEFAULT_ORIGIN_DBM;
  let running = originDbm;
  const stages: ChainStage[] = chain.map((n, i) => {
    const isTerminal = i === chain.length - 1;
    const child = isTerminal ? null : chain[i + 1];
    const wantsTap = isTerminal ? true : (child?.fbtcLeg ?? 'through') === 'tap';
    const key = refKey(n.splitterType, n.splitterRatio, n.ports);
    const useTap = n.splitterType === 'FBTC' && wantsTap && key !== '' && tapMap.has(key);
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

  // A secondary in-box FBT/PLC splitter only applies to the NAP actually being
  // queried — i.e. its own local clients — never to a descendant cascaded off it.
  const target = chain[chain.length - 1];
  if (target?.secondarySplitterType && target?.secondarySplitterRatio) {
    const key2 = refKey(target.secondarySplitterType, target.secondarySplitterRatio, null);
    const lossDb2 = throughMap.has(key2) ? (throughMap.get(key2) as number) : null;
    if (lossDb2 != null) running -= lossDb2;
    stages.push({
      napId: target.id,
      name: `${target.name} — secondary splitter`,
      splitterType: target.secondarySplitterType,
      splitterRatio: target.secondarySplitterRatio,
      leg: 'through',
      lossDb: lossDb2,
      after: running,
      secondary: true,
    });
  }

  return { oltId: olt?.id ?? null, oltName: olt?.name ?? null, originDbm, stages, receivedDbm: running };
}
