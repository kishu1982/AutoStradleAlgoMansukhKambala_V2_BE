// Central place to manage all WS subscriptions

export const WS_SUBSCRIPTIONS = {
  DEFAULT: [
    // 'NSE|2885', // RELIANCE
    // 'NSE|1594', // INFY
    'NFO|49229', // NIFTY FUT
    'MCX|472780', // GOLDM
    // 'NFO|58751', // nifty call FUT
    'NSE|2475', //ONGC
    'NSE|26000', //NIFTY SPOT
    'NSE|26009', //BANK NIFTY
    'BSE|1', //SENSEX SPOT
  ],

  EQUITIES: ['NSE|22', 'NSE|1594'],

  DERIVATIVES: ['NFO|35003'],

  COMMODITIES: ['MCX|487866'], 
};
