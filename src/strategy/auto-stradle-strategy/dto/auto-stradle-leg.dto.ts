import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
} from 'class-validator';

export class AutoStradleLegDto {
  @IsEnum(['NSE', 'NFO', 'BSE', 'BFO'], {
    message: 'exch must be one of NSE, NFO, BSE, BFO',
  })
  @IsNotEmpty()
  exch: 'NSE' | 'NFO' | 'BSE' | 'BFO';

  @IsEnum(['FUTIDX', 'OPTIDX'], {
    message: 'instrument must be one of FUTIDX, OPTIDX',
  })
  @IsNotEmpty()
  instrument: 'FUTIDX' | 'OPTIDX';

  @IsEnum(['PE', 'CE'], {
    message: 'optionType must be either PE or CE',
  })
  @IsNotEmpty()
  optionType: 'PE' | 'CE';

  @IsString()
  @IsNotEmpty()
  expiry: string;

  @IsEnum(['BUY', 'SELL', 'EXIT'], {
    message: 'side must be one of BUY, SELL, EXIT',
  })
  @IsNotEmpty()
  side: 'BUY' | 'SELL' | 'EXIT';

  // ✅ NEW OPTIONAL FIELDS

  @IsOptional()
  @IsString()
  tokenNumber?: string;

  @IsOptional()
  @IsString()
  tradingSymbol?: string;

  @IsOptional()
  @IsNumber() // Assuming legLtp is a number, adjust if it's a string
  legLtp?: number;

  @IsOptional()
  @IsNumber()
  quantityLots?: number;

  @IsOptional()
  @IsNumber()
  ratio?: number;
}
