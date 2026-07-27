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
}

export interface ChainStage {
  napId: number;
  name: string;
  splitterType?: string | null;
  splitterRatio?: string | null;
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

/** Walks a NAP's parent chain up to its OLT, subtracting each hop's splitter loss. */
export function computeNapChainDbm(
  napId: number,
  napsById: Map<number, ChainNapLike>,
  splitterRows: SplitterRefLike[]
): ChainResult | null {
  const refMap = new Map(splitterRows.map((r) => [`${r.type}|${r.ratio}`, r.throughLossDb]));
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
  const stages: ChainStage[] = chain.map((n) => {
    const key = n.splitterType && n.splitterRatio ? `${n.splitterType}|${n.splitterRatio}` : '';
    const lossDb = key && refMap.has(key) ? (refMap.get(key) as number) : null;
    if (lossDb != null) running -= lossDb;
    return {
      napId: n.id,
      name: n.name,
      splitterType: n.splitterType,
      splitterRatio: n.splitterRatio,
      lossDb,
      after: running,
    };
  });
  return { oltId: olt?.id ?? null, oltName: olt?.name ?? null, originDbm, stages, receivedDbm: running };
}
