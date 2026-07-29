// dto/UpdateAutoStradleStrategyDto.ts
import { PartialType } from '@nestjs/mapped-types';
import { CreateAutoStradleStrategyDto } from './create-auto-stradle-strategy.dto';

export class UpdateAutoStradleStrategyDto extends PartialType(
  CreateAutoStradleStrategyDto,
) {}
