export interface InstrumentInfo {
  exchange: string; // NFO
  token: string; // 64858

  symbol: string; // NIFTY
  tradingSymbol: string; // NIFTY24FEB26C25650

  expiry?: string;

  instrument: 'OPTIDX' | 'FUTIDX' | string;

  optionType?: 'CE' | 'PE';

  strikePrice?: number;

  lotSize?: number;
  tickSize?: number;

  precision?: number | null;
  multiplier?: number | null;

  indexToken?: string | null;

  raw?: {
    Exchange?: string;
    Token?: string;
    LotSize?: string;
    Symbol?: string;
    TradingSymbol?: string;
    Expiry?: string;
    Instrument?: string;
    OptionType?: string;
    StrikePrice?: string;
    TickSize?: string;
  };
}
