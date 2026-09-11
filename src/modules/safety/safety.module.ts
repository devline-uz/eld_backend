import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyRepository } from './safety.repository';
import { SafetyService } from './safety.service';

/** TZ §11.5 / eld.docs §9 — harsh events, scoring, coaching. */
@Module({
  controllers: [SafetyController],
  providers: [SafetyService, SafetyRepository],
  exports: [SafetyService, SafetyRepository],
})
export class SafetyModule {}
