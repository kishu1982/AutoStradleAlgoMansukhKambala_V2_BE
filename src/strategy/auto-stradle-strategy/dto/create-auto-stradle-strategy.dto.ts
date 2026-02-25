import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { AutoStradleLegDto } from './auto-stradle-leg.dto';

enum TradeSide {
  BUY = 'BUY',
  SELL = 'SELL',
  EXIT = 'EXIT',
}

export class CreateAutoStradleStrategyDto {
  @IsString()
  @IsNotEmpty()
  strategyName: string; // e.g., "StradleTrades" - MANDATORY

  @IsString()
  @IsNotEmpty()
  tokenNumber: string; // e.g., "48236" - MANDATORY

  @IsString()
  @IsNotEmpty()
  exchange: string; // e.g., "NFO" - MANDATORY

  @IsString()
  @IsNotEmpty()
  symbolName: string; // e.g., "NIFTY17FEB26C26000" - MANDATORY

  @IsNumber()
  @IsNotEmpty()
  @Min(1, { message: 'quantityLots must be at least 1' })
  quantityLots: number; // Default: 1 - MANDATORY

  @IsEnum(TradeSide, { message: 'side must be one of BUY, SELL, EXIT' })
  @IsNotEmpty()
  side: TradeSide; // MANDATORY

  @IsEnum(['INTRADAY', 'NORMAL', 'DELIVERY'])
  @IsNotEmpty()
  productType: 'INTRADAY' | 'NORMAL' | 'DELIVERY'; // MANDATORY

  @IsNumber()
  @Min(1, { message: 'legs count must be at least 1' })
  @IsNotEmpty()
  legs: number; // e.g., 2 - MANDATORY

  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AutoStradleLegDto)
  legsData: AutoStradleLegDto[]; // MANDATORY - array of legs matching legs count

  @IsNumber()
  @Min(0, { message: 'amountForLotCalEachLeg cannot be negative' })
  @IsNotEmpty()
  amountForLotCalEachLeg: number; // e.g., 25000 - MANDATORY

  @IsNumber()
  @Min(0, { message: 'profitBookingPercentage cannot be negative' })
  @IsNotEmpty()
  profitBookingPercentage: number; // e.g., 10 (represents 10%) - MANDATORY

  @IsNumber()
  @Min(0, { message: 'stoplossBookingPercentage cannot be negative' })
  @IsNotEmpty()
  stoplossBookingPercentage: number; // e.g., 10 (represents 10%) - MANDATORY

  @IsNumber()
  @Min(0, { message: 'otmDifference cannot be negative' })
  @IsNotEmpty()
  otmDifference: number; // e.g., 0.25 (represents 0.25%) - MANDATORY

  @IsOptional()
  @IsEnum(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE'; // Optional status

  @IsOptional()
  @IsNumber()
  ltp?: number; // last traded price - Optional, can be updated from market data feed
}
