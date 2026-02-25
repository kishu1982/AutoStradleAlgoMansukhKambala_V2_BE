import {
  Entity,
  ObjectIdColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectId } from 'mongodb';

export interface AutoStradleLeg {
  exch: 'NSE' | 'NFO' | 'BSE' | 'BFO' | 'MCX'; // MANDATORY
  instrument: 'FUTIDX' | 'OPTIDX'; // MANDATORY
  optionType: 'PE' | 'CE'; // MANDATORY
  expiry: string; // Format: "17-FEB-2026" - MANDATORY
  side: 'BUY' | 'SELL' | 'EXIT'; // MANDATORY
  tokenNumber?: string; // Optional, can be used for quick reference
  tradingSymbol?: string; // Optional, can be used for quick reference
  legLtp?: number; // Optional, can be updated from market data feed
  // ⭐ ADD THIS
  quantityLots?: number; // Optional, can be used for quick reference or override
  ratio?: number; // Optional, can be used for quantity calculation based on main leg
}

@Entity('auto_stradle_data')
@Index(['tokenNumber', 'exchange', 'symbolName', 'side'], { unique: true })
export class AutoStradleDataEntity {
  @ObjectIdColumn()
  _id: ObjectId;

  @Column()
  strategyName: string; // e.g., "StradleTrades" - MANDATORY

  @Column()
  tokenNumber: string; // e.g., "48236" - MANDATORY

  @Column()
  exchange: string; // e.g., "NFO" - MANDATORY

  @Column()
  symbolName: string; // e.g., "NIFTY17FEB26C26000" - MANDATORY

  @Column()
  quantityLots: number; // Default: 1 - MANDATORY

  @Column()
  side: 'BUY' | 'SELL' | 'EXIT'; // MANDATORY

  @Column()
  productType: 'INTRADAY' | 'NORMAL' | 'DELIVERY'; // MANDATORY

  @Column()
  legs: number; // e.g., 2 - MANDATORY, total number of legs

  @Column()
  legsData: AutoStradleLeg[]; // Array of leg configurations - MANDATORY

  @Column()
  amountForLotCalEachLeg: number; // e.g., 25000 - MANDATORY, for calculating lot quantities

  @Column()
  profitBookingPercentage: number; // e.g., 10 (represents 10%) - MANDATORY

  @Column()
  stoplossBookingPercentage: number; // e.g., 10 (represents 10%) - MANDATORY

  @Column()
  otmDifference: number; // e.g., 0.25 (represents 0.25%) - MANDATORY, leg difference from main signal

  @Column({ nullable: true })
  status?: 'ACTIVE' | 'INACTIVE'; // Optional status field

  @Column()
  ltp?: number; // last traded price - Optional, can be updated from market data feed

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
