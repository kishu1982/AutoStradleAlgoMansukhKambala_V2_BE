export interface MarketTick {
  t?: string; // touchline acknowledgement
  e: string; // exchange
  tk: string; // token

  lp?: number; // last traded price
  pc?: number; // percentage change
  v?: number; // volume

  o?: number; // open
  h?: number; // high
  l?: number; // low
  c?: number; // close

  ap?: number; // average price

  oi?: number;
  poi?: number;
  toi?: number;

  bq1?: number;
  bp1?: number;
  sq1?: number;
  sp1?: number;
}
