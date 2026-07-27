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
  txDbm?: number | null;
}

export interface SplitterRefLike {
  type: string;
  ratio: string;
  throughLossDb: number;
  tapLossDb?: number | null;
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
 * loss. FBTC (asymmetric tap cassette) hops use their through-loss (trunk
 * continue) when the chain passes through them on the way to a further-down
 * NAP, and their tap-loss (subscriber drop) for the terminal NAP — the one
 * clients actually attach to — matching the manual budget calculator's
 * through/tap leg semantics. FBT/PLC (symmetric splitters) always use the
 * single per-leg loss value regardless of position.
 */
export function computeNapChainDbm(
  napId: number,
  napsById: Map<number, ChainNapLike>,
  splitterRows: SplitterRefLike[]
): ChainResult | null {
  const throughMap = new Map(splitterRows.map((r) => [`${r.type}|${r.ratio}`, r.throughLossDb]));
  const tapMap = new Map(
    splitterRows.filter((r) => r.tapLossDb != null).map((r) => [`${r.type}|${r.ratio}`, r.tapLossDb as number])
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
    const key = n.splitterType && n.splitterRatio ? `${n.splitterType}|${n.splitterRatio}` : '';
    const useTap = isTerminal && n.splitterType === 'FBTC' && key !== '' && tapMap.has(key);
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
  return { oltId: olt?.id ?? null, oltName: olt?.name ?? null, originDbm, stages, receivedDbm: running };
}
