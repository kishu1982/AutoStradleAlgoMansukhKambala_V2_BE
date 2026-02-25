import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from './../token/token.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AxiosError } from 'axios';
import { PlaceOrderDto } from './dto/place-order.dto';

const NorenRestApi = require('norenrestapi/lib/restapi');

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private api: any;

  constructor(
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
  ) {
    this.api = new NorenRestApi({});
  }

  // place orders
  // async placeOrder(order: {
  //   buy_or_sell: 'B' | 'S';
  //   product_type: 'C' | 'M' | 'H';
  //   exchange: string;
  //   tradingsymbol: string;
  //   quantity: number;
  //   price_type: string;
  //   price?: number;
  //   retention?: string;
  //   remarks?: string;
  // }) {
  //   const token = this.tokenService.getToken();
  //   const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

  //   const jData = {
  //     uid: token.UID,
  //     actid: token.Account_ID,
  //     exch: order.exchange,
  //     tsym: order.tradingsymbol,
  //     qty: String(order.quantity),
  //     prc: String(order.price ?? 0),
  //     prd: order.product_type,
  //     trantype: order.buy_or_sell,
  //     prctyp: order.price_type,
  //     ret: order.retention ?? 'DAY',
  //     remarks: order.remarks ?? '',
  //     ordersource: 'API', // 🔥 REQUIRED
  //   };

  //   const payload = `jData=${JSON.stringify(jData)}`;

  //   this.logger.debug(`📤 RAW PlaceOrder → ${payload}`);

  //   const response = await axios.post(`${baseUrl}/PlaceOrder`, payload, {
  //     headers: {
  //       Authorization: `Bearer ${token.Access_token}`,
  //       'Content-Type': 'application/json',
  //     },
  //     transformRequest: [(d) => d],
  //     timeout: 10000,
  //   });

  //   if (response.data?.stat === 'Not_Ok') {
  //     throw new Error(response.data.emsg);
  //   }

  //   return response.data;
  // }
  // async placeOrder(order: {
  //   buy_or_sell: 'B' | 'S';
  //   product_type: 'C' | 'M' | 'H';
  //   exchange: string;
  //   tradingsymbol: string;
  //   quantity: number;
  //   price_type: 'LMT' | 'MKT' | 'SL-LMT' | 'SL-MKT';
  //   price?: number;
  //   trigger_price?: number;
  //   retention?: string;
  //   remarks?: string;
  // }) {
  // async placeOrder(order: PlaceOrderDto) {
  //   const token = this.tokenService.getToken();
  //   const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

  //   /* ---------------- VALIDATION (BLOCK BAD REQUESTS) ---------------- */

  //   if (
  //     (order.price_type === 'SL-LMT' || order.price_type === 'SL-MKT') &&
  //     order.trigger_price === undefined
  //   ) {
  //     throw new BadRequestException(
  //       'trigger_price is mandatory for stop loss orders',
  //     );
  //   }

  //   if (
  //     (order.price_type === 'LMT' || order.price_type === 'SL-LMT') &&
  //     order.price === undefined
  //   ) {
  //     throw new BadRequestException('price is mandatory for limit orders');
  //   }

  //   /* ---------------- BUILD Noren PAYLOAD ---------------- */

  //   const jData: any = {
  //     uid: token.UID,
  //     actid: token.Account_ID,
  //     exch: order.exchange,
  //     tsym: order.tradingsymbol,
  //     qty: String(order.quantity),
  //     prd: order.product_type,
  //     trantype: order.buy_or_sell,
  //     prctyp: order.price_type,
  //     ret: order.retention ?? 'DAY',
  //     remarks: order.remarks ?? '',
  //     ordersource: 'API',
  //   };

  //   // Price (not required for MKT)
  //   if (order.price_type !== 'MKT') {
  //     jData.prc = String(order.price ?? 0);
  //   }

  //   // Trigger price for Stop Loss
  //   if (order.price_type === 'SL-LMT' || order.price_type === 'SL-MKT') {
  //     jData.trgprc = String(order.trigger_price);
  //   }

  //   const payload = `jData=${JSON.stringify(jData)}`;

  //   this.logger.debug(`📤 PlaceOrder RAW → ${payload}`);

  //   /* ---------------- API CALL ---------------- */

  //   try {
  //     const response = await axios.post(`${baseUrl}/PlaceOrder`, payload, {
  //       headers: {
  //         Authorization: `Bearer ${token.Access_token}`,
  //         'Content-Type': 'application/x-www-form-urlencoded',
  //       },
  //       transformRequest: [(d) => d],
  //       timeout: 10000,
  //     });

  //     /* ---------------- BROKER ERROR ---------------- */

  //     if (response.data?.stat === 'Not_Ok') {
  //       this.logger.warn(`❌ Noren Order Error → ${response.data.emsg}`);

  //       throw new BadRequestException({
  //         message: 'Order rejected by broker',
  //         brokerError: response.data.emsg,
  //       });
  //     }

  //     return response.data;
  //   } catch (error) {
  //     /* ---------------- AXIOS ERROR ---------------- */

  //     if (error instanceof AxiosError) {
  //       const brokerMsg =
  //         error.response?.data?.emsg ||
  //         error.response?.data?.message ||
  //         error.message;

  //       this.logger.error(`🚨 PlaceOrder Axios Error → ${brokerMsg}`);

  //       throw new BadRequestException({
  //         message: 'Failed to place order',
  //         brokerError: brokerMsg,
  //         statusCode: error.response?.status,
  //       });
  //     }

  //     /* ---------------- UNKNOWN ERROR ---------------- */

  //     this.logger.error('🔥 Unexpected PlaceOrder Error', error);

  //     throw new InternalServerErrorException({
  //       message: 'Unexpected error while placing order',
  //     });
  //   }
  // }

  async placeOrder(order: PlaceOrderDto) {
    const token = this.tokenService.getToken();
    const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

    /* ---------------- SANITIZE ---------------- */

    const exchange = order.exchange?.trim();
    const tradingsymbol = order.tradingsymbol?.trim();

    if (!exchange || !tradingsymbol) {
      throw new BadRequestException('Exchange or Trading Symbol missing');
    }

    /* ---------------- BASE PAYLOAD ---------------- */

    const jData: any = {
      uid: String(token.UID),
      actid: String(token.Account_ID),
      exch: exchange,
      tsym: tradingsymbol,
      qty: String(Math.floor(order.quantity)),
      prc: '0.0', // ✅ REQUIRED EVEN FOR MKT
      prd: order.product_type,
      trantype: order.buy_or_sell,
      prctyp: order.price_type,
      ret: order.retention ?? 'DAY',
      remarks: order.remarks ?? '',
      ordersource: 'API',
    };

    /* ---------------- ORDER TYPE RULES ---------------- */

    if (order.price_type === 'LMT' || order.price_type === 'SL-LMT') {
      if (order.price === undefined) {
        throw new BadRequestException('Price required for LMT / SL-LMT');
      }
      jData.prc = String(order.price);
    }

    if (order.price_type === 'SL-MKT' || order.price_type === 'SL-LMT') {
      if (order.trigger_price === undefined) {
        throw new BadRequestException('Trigger price required for SL order');
      }
      jData.trgprc = String(order.trigger_price);
    }

    /* ---------------- FINAL PAYLOAD (THIS IS KEY) ---------------- */

    const payload = `jData=${JSON.stringify(jData)}`;

    this.logger.debug(`📤 FINAL RAW PAYLOAD → ${payload}`);

    /* ---------------- API CALL ---------------- */

    try {
      const response = await axios.post(
        `${baseUrl}/PlaceOrder`,
        payload, // ✅ RAW STRING
        {
          headers: {
            Authorization: `Bearer ${token.Access_token}`,
            'Content-Type': 'application/json', // ✅ SAME AS CURL
          },
          transformRequest: [(d) => d], // 🚨 REQUIRED
          timeout: 10000,
        },
      );

      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Order rejected by broker',
          brokerError: response.data.emsg,
        });
      }

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new BadRequestException({
          message: 'Failed to place order',
          brokerError:
            error.response?.data?.emsg ||
            error.response?.data?.message ||
            error.message,
          statusCode: error.response?.status,
        });
      }

      throw new InternalServerErrorException(
        'Unexpected error while placing order',
      );
    }
  }

  /* ========================= MODIFY ORDER ========================= */

  async modifyOrder(data: {
    orderno: string;
    exchange: string;
    tradingsymbol: string;
    quantity?: number; // 🔥 ADD THIS
    newprice_type: 'SL-MKT' | 'SL-LMT' | 'LMT' | 'MKT';
    newprice?: string | number;
    newtrigger_price?: string | number;
  }) {
    const token = this.tokenService.getToken();
    const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

    /* ---------------- REQUIRED VALIDATION ---------------- */

    if (!data.orderno || !data.exchange || !data.tradingsymbol) {
      throw new BadRequestException(
        'orderno, exchange and tradingsymbol are required',
      );
    }

    if (
      (data.newprice_type === 'SL-MKT' || data.newprice_type === 'SL-LMT') &&
      data.newtrigger_price === undefined
    ) {
      throw new BadRequestException(
        'newtrigger_price is required for stop loss orders',
      );
    }

    /* ---------------- BUILD EXACT PAYLOAD ---------------- */

    const jData: any = {
      uid: token.UID,
      exch: data.exchange,
      tsym: data.tradingsymbol,
      norenordno: data.orderno,
      qty: String(data.quantity ?? 1), // 🔥 REQUIRED
      prctyp: data.newprice_type,
      ordersource: 'API',
    };

    /**
     * 🔥 SL-MKT RULE (MANDATORY)
     */
    if (data.newprice_type === 'SL-MKT') {
      jData.prc = '0'; // MUST be sent
      jData.trgprc = String(data.newtrigger_price);
    }

    /**
     * SL-LMT
     */
    if (data.newprice_type === 'SL-LMT') {
      jData.prc = String(data.newprice);
      jData.trgprc = String(data.newtrigger_price);
    }

    /**
     * LMT
     */
    if (data.newprice_type === 'LMT') {
      jData.prc = String(data.newprice);
    }

    const payload = `jData=${JSON.stringify(jData)}`;

    this.logger.debug(`📤 MODIFY ORDER → ${payload}`);

    /* ---------------- API CALL ---------------- */

    try {
      const response = await axios.post(`${baseUrl}/ModifyOrder`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json',
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Order modification rejected by exchange',
          brokerError: response.data.emsg,
          raw: response.data,
        });
      }

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new BadRequestException({
          message: 'Modify order failed',
          brokerError:
            error.response?.data?.emsg || error.response?.data || error.message,
        });
      }

      throw new InternalServerErrorException(
        'Unexpected error while modifying order',
      );
    }
  }

  /* ========================= CANCEL ORDER ========================= */

  async cancelOrder(orderno: string) {
    this.logger.log(`📥 Cancel order request → ${orderno}`);

    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
        norenordno: orderno,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 CANCEL ORDER → ${payload}`);

      const response = await axios.post(`${baseUrl}/CancelOrder`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json',
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      // ❌ Logical error from Noren
      if (response.data?.stat === 'Not_Ok') {
        this.logger.error(`❌ CancelOrder failed → ${response.data.emsg}`);
        return {
          success: false,
          source: 'NOREN',
          error: response.data.emsg,
          raw: response.data,
        };
      }

      this.logger.log(`✅ Order cancelled successfully → ${orderno}`);

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      // ❌ Axios error with response
      if (error.response) {
        this.logger.error(`❌ CancelOrder Axios error`, error.response.data);

        return {
          success: false,
          source: 'NETWORK',
          statusCode: error.response.status,
          error: error.response.data,
        };
      }

      // ❌ No response (timeout / DNS)
      if (error.request) {
        this.logger.error(`❌ CancelOrder no response from server`);

        return {
          success: false,
          source: 'NETWORK',
          error: 'No response from Noren API',
        };
      }

      // ❌ Application error
      this.logger.error(`❌ CancelOrder application error`, error.message);

      return {
        success: false,
        source: 'APPLICATION',
        error: error.message || 'Unexpected error',
      };
    }
  }

  /* ========================= EXIT ORDER ========================= */

  async exitOrder(data: { orderno: string; prd: 'H' | 'B' }) {
    this.logger.log(`📥 Exit order request → ${data.orderno}`);

    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
        norenordno: data.orderno,
        prd: data.prd,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 EXIT ORDER → ${payload}`);

      const response = await axios.post(`${baseUrl}/ExitOrder`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json',
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      // ❌ Logical error from Noren
      if (response.data?.stat === 'Not_Ok') {
        this.logger.error(`❌ ExitOrder failed → ${response.data.emsg}`);
        return {
          success: false,
          source: 'NOREN',
          error: response.data.emsg,
          raw: response.data,
        };
      }

      this.logger.log(`✅ Exit order successful → ${data.orderno}`);

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      // ❌ Axios error with response
      if (error.response) {
        this.logger.error(`❌ ExitOrder Axios error`, error.response.data);

        return {
          success: false,
          source: 'NETWORK',
          statusCode: error.response.status,
          error: error.response.data,
        };
      }

      // ❌ No response
      if (error.request) {
        this.logger.error(`❌ ExitOrder no response from server`);

        return {
          success: false,
          source: 'NETWORK',
          error: 'No response from Noren API',
        };
      }

      // ❌ Application error
      this.logger.error(`❌ ExitOrder application error`, error.message);

      return {
        success: false,
        source: 'APPLICATION',
        error: error.message || 'Unexpected error',
      };
    }
  }

  /* ===================== GET ORDER MARGIN ===================== */

  async getOrderMargin(data: {
    exchange: string;
    tradingsymbol: string;
    quantity: number;
    price: number;
    product: string; // C / M / H
    transactionType: 'B' | 'S';
    priceType: string; // LMT / MKT / SL-LMT / SL-MKT
  }) {
    const token = this.tokenService.getToken();
    const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

    const jData = {
      uid: token.UID,
      actid: token.Account_ID,
      exch: data.exchange,
      tsym: data.tradingsymbol,
      qty: String(data.quantity), // MUST be string
      prc: String(data.price), // MUST be string
      prd: data.product,
      trantype: data.transactionType,
      prctyp: data.priceType,
    };

    const payload = `jData=${JSON.stringify(jData)}`;

    this.logger.debug(`📤 GET ORDER MARGIN → ${payload}`);

    try {
      const response = await axios.post(`${baseUrl}/GetOrderMargin`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ EXACT MATCH
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      if (response.data?.stat === 'Not_Ok') {
        throw new Error(response.data.emsg);
      }

      return response.data;
    } catch (error) {
      this.logger.error(
        '❌ GetOrderMargin failed',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  /* ===================== TRADE BOOK ===================== */

  // async getTradeBook() {
  //   try {
  //     const token = this.tokenService.getToken();
  //     const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

  //     if (!token?.Access_token) {
  //       throw new UnauthorizedException('Access token not found');
  //     }

  //     const jData = {
  //       uid: token.UID,
  //       actid: token.Account_ID,
  //     };

  //     const payload = `jData=${JSON.stringify(jData)}`;

  //     this.logger.debug(`📤 TRADE BOOK → ${payload}`);

  //     const response = await axios.post(`${baseUrl}/TradeBook`, payload, {
  //       headers: {
  //         Authorization: `Bearer ${token.Access_token}`,
  //         'Content-Type': 'text/plain',
  //       },
  //       transformRequest: [(d) => d],
  //       timeout: 10000,
  //     });

  //     /* ❌ Noren logical error */
  //     if (response.data?.stat === 'Not_Ok') {
  //       throw new BadRequestException({
  //         message: 'TradeBook request failed',
  //         error: response.data.emsg,
  //         raw: response.data,
  //       });
  //     }

  //     /* ✅ Success */
  //     return {
  //       success: true,
  //       data: response.data,
  //     };
  //   } catch (error) {
  //     /* ❌ Axios / Network / API error */
  //     if (error instanceof AxiosError) {
  //       this.logger.error(
  //         '❌ TradeBook Axios Error',
  //         error.response?.data || error.message,
  //       );

  //       throw new BadRequestException({
  //         message: 'Failed to fetch TradeBook from Noren',
  //         error: error.response?.data || error.message,
  //       });
  //     }

  //     /* ❌ Already handled Nest exception */
  //     if (
  //       error instanceof BadRequestException ||
  //       error instanceof UnauthorizedException
  //     ) {
  //       throw error;
  //     }

  //     /* ❌ Unknown error */
  //     this.logger.error('❌ TradeBook Unknown Error', error);

  //     throw new InternalServerErrorException(
  //       'Unexpected error while fetching TradeBook',
  //     );
  //   }
  // }
  /* ===================== POSITION BOOK ===================== */

  async getPositionBook() {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not available');
      }

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 POSITION BOOK → ${payload}`);

      const response = await axios.post(`${baseUrl}/PositionBook`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ MUST match curl
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'PositionBook request failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ PositionBook Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch PositionBook from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already handled */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown error */
      this.logger.error('❌ PositionBook Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching PositionBook',
      );
    }
  }

  /* ===================== HOLDINGS ===================== */

  async getHoldings(prd: 'C' | 'M' | 'H' = 'C') {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not available');
      }

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
        prd,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 HOLDINGS → ${payload}`);

      const response = await axios.post(`${baseUrl}/Holdings`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json', // ✅ matches curl
        },
        transformRequest: [(d) => d], // 🚨 REQUIRED
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Holdings request failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ Holdings Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch Holdings from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already handled */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown error */
      this.logger.error('❌ Holdings Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching Holdings',
      );
    }
  }

  /* ===================== ORDER REPORT ===================== */

  async getOrderReport(data: {
    from_date: string; // DD-MM-YYYY
    to_date: string; // DD-MM-YYYY
    brkname?: string;
  }) {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not available');
      }

      if (!data?.from_date || !data?.to_date) {
        throw new BadRequestException(
          'from_date and to_date are required (DD-MM-YYYY)',
        );
      }

      const jData = {
        actid: token.Account_ID,
        from_date: data.from_date,
        to_date: data.to_date,
        brkname: data.brkname ?? '',
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 ORDER REPORT → ${payload}`);

      const response = await axios.post(`${baseUrl}/GetOrderReport`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ MUST match curl
        },
        transformRequest: [(d) => d], // 🚨 REQUIRED
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Order report failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ OrderReport Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch Order Report from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already-handled Nest errors */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown crash */
      this.logger.error('❌ OrderReport Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching Order Report',
      );
    }
  }
  /* ========================= TRADE REPORT ========================= */

  async getTradeReport(data: {
    from_date: string;
    to_date: string;
    brkname?: string;
  }) {
    try {
      // ✅ Basic validation
      if (!data?.from_date || !data?.to_date) {
        throw new BadRequestException(
          'from_date and to_date are required (DD-MM-YYYY)',
        );
      }

      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      const jData = {
        actid: token.Account_ID,
        from_date: data.from_date,
        to_date: data.to_date,
        brkname: data.brkname ?? '',
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 TRADE REPORT → ${payload}`);

      const response = await axios.post(`${baseUrl}/GetTradeReport`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ EXACT as curl
        },
        transformRequest: [(d) => d], // 🚨 REQUIRED
        timeout: 10000,
      });

      // ❌ Noren logical error
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Trade report failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ TradeReport Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch trade report',
          error: error.response?.data || error.message,
        });
      }

      this.logger.error(
        '❌ Unexpected TradeReport error',
        error.message,
        error.stack,
      );

      throw new InternalServerErrorException(
        'Unexpected error while fetching trade report',
      );
    }
  }

  /* ========================= NET POSITIONS ========================= */

  // async getNetPositions() {
  //   let api: any;

  //   try {
  //     const token = this.tokenService.getToken();

  //     // ✅ SDK init (can throw synchronously)
  //     api = new NorenRestApi({
  //       Access_token: token.Access_token,
  //       UID: token.UID,
  //       AID: token.Account_ID,
  //     });

  //     this.logger.debug('📤 SDK get_positions called');

  //     const response = await api.get_positions();
  //     console.log(`response from getNetpostiions: `, response);

  //     // ❗ Noren logical error
  //     if (response?.stat === 'Not_Ok') {
  //       this.logger.warn(`⚠️ Noren get_positions error: ${response.emsg}`);

  //       throw new BadRequestException(
  //         response.emsg || 'Failed to fetch net positions',
  //       );
  //     }

  //     return {
  //       success: true,
  //       data: response,
  //     };
  //   } catch (err) {
  //     // 🔒 NEVER assume err is Error
  //     const safeMessage =
  //       typeof err === 'string'
  //         ? err
  //         : err?.message
  //           ? err.message
  //           : 'Unknown SDK error';

  //     this.logger.error(
  //       '❌ SDK get_positions failed',
  //       JSON.stringify({
  //         message: safeMessage,
  //       }),
  //     );

  //     // ✅ Already handled HTTP error
  //     if (err instanceof BadRequestException) {
  //       throw err;
  //     }

  //     // ✅ SDK / runtime error
  //     throw new InternalServerErrorException(
  //       safeMessage || 'Unexpected error while fetching net positions',
  //     );
  //   }
  // }
  async getNetPositions() {
    let api: any;

    try {
      const token = this.tokenService.getToken();

      api = new NorenRestApi({
        Access_token: token.Access_token,
        UID: token.UID,
        AID: token.Account_ID,
      });

      this.logger.debug('📤 SDK get_positions called');

      const response = await api.get_positions();

      // this.logger.debug(
      //   `📥 get_positions response: ${JSON.stringify(response)}`,
      // );

      // ✅ Noren "no data" is NOT an error
      if (
        response?.stat === 'Not_Ok' &&
        typeof response?.emsg === 'string' &&
        response.emsg.toLowerCase().includes('no data')
      ) {
        this.logger.warn('ℹ️ No net positions found (no trades yet)');

        return {
          success: true,
          data: [], // ✅ IMPORTANT
        };
      }

      // ❗ Real Noren error
      if (response?.stat === 'Not_Ok') {
        this.logger.error(`❌ Noren get_positions error: ${response.emsg}`);

        return {
          success: false,
          data: [],
          error: response.emsg || 'Failed to fetch net positions',
        };
      }

      // ✅ Success
      return {
        success: true,
        data: response,
      };
    } catch (err) {
      // 🔒 Never crash app for strategy usage
      const safeMessage =
        typeof err === 'string' ? err : err?.message || 'Unknown SDK error';

      this.logger.error('❌ SDK get_positions exception', safeMessage);

      // ✅ Return safe empty response
      return {
        success: false,
        data: [],
        error: safeMessage,
      };
    }
  }

  /* ================= GET ORDER BOOK ================= */

  async getOrderBook() {
    try {
      // 🔐 Load saved token
      const token = this.tokenService.getToken();

      if (!token?.Access_token || !token?.UID || !token?.Account_ID) {
        this.logger.warn(
          '⚠️ Missing or invalid token while fetching order book',
        );

        return {
          status: 'ERROR',
          count: 0,
          trades: [],
          message: 'Unauthorized or missing token',
        };
      }

      // 🧠 Init SDK
      const api = new NorenRestApi();
      this.tokenService.prepareSdk(api);

      this.logger.debug('📤 SDK get_orderbook called');

      const response = await api.get_orderbook();

      /**
       * ✅ CASE 1: Empty array → valid no data
       */
      if (Array.isArray(response) && response.length === 0) {
        return {
          status: 'OK',
          count: 0,
          trades: [],
          message: 'No trade data available',
        };
      }

      /**
       * ✅ CASE 2: Not_Ok but means NO DATA
       */
      if (
        response?.stat === 'Not_Ok' &&
        typeof response?.emsg === 'string' &&
        response.emsg.toLowerCase().includes('no')
      ) {
        return {
          status: 'OK',
          count: 0,
          trades: [],
          message: response.emsg,
        };
      }

      /**
       * ❌ CASE 3: Real API error → soft fail
       */
      if (response?.stat === 'Not_Ok') {
        this.logger.error('❌ Order book API error', response.emsg);

        return {
          status: 'ERROR',
          count: 0,
          trades: [],
          message: response.emsg || 'Order book fetch failed',
        };
      }

      /**
       * ✅ CASE 4: Normal success
       */
      return {
        status: 'OK',
        count: Array.isArray(response) ? response.length : 0,
        trades: response,
      };
    } catch (error) {
      // 🚨 NEVER crash the app
      this.logger.error(
        '❌ getOrderBook crashed',
        error?.message,
        error?.stack,
      );

      return {
        status: 'ERROR',
        count: 0,
        trades: [],
        message: 'Unexpected error while fetching order book',
      };
    }
  }

  /* ================= GET TRADE BOOK ================= */

  async getTradeBook() {
    try {
      const token = this.tokenService.getToken();

      if (!token?.Access_token || !token?.UID || !token?.Account_ID) {
        throw new UnauthorizedException('Invalid or missing access token');
      }

      const api = new NorenRestApi();
      this.tokenService.prepareSdk(api);

      this.logger.debug('📤 SDK get_tradebook called');

      const response = await api.get_tradebook();

      /**
       * ✅ CASE 1: Empty array → NO DATA (valid)
       */
      if (Array.isArray(response) && response.length === 0) {
        return {
          status: 'OK',
          count: 0,
          trades: [],
          message: 'No trade data available',
        };
      }

      /**
       * ✅ CASE 2: API returns Not_Ok but means NO DATA
       */
      if (
        response?.stat === 'Not_Ok' &&
        typeof response?.emsg === 'string' &&
        response.emsg.toLowerCase().includes('no')
      ) {
        return {
          status: 'OK',
          count: 0,
          trades: [],
          message: response.emsg || 'No trade data available',
        };
      }

      /**
       * ❌ CASE 3: Real API error
       */
      if (response?.stat === 'Not_Ok') {
        throw new InternalServerErrorException({
          message: 'Trade book fetch failed',
          error: response.emsg,
          raw: response,
        });
      }

      /**
       * ✅ CASE 4: Normal success
       */
      return {
        status: 'OK',
        count: Array.isArray(response) ? response.length : 0,
        trades: response,
      };
    } catch (error) {
      this.logger.error('❌ getTradeBook failed', error.message, error.stack);

      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new InternalServerErrorException({
        message: 'Failed to fetch trade book',
        error: error.message,
      });
    }
  }
}
