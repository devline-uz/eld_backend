import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyRepository } from './safety.repository';
import { SafetyScoreService } from './safety-score.service';
import { SafetyService } from './safety.service';

/** TZ §11.5 / eld.docs §9 — harsh events, scoring, coaching. */
@Module({
  controllers: [SafetyController],
  providers: [SafetyService, SafetyRepository, SafetyScoreService],
  exports: [SafetyService, SafetyRepository, SafetyScoreService],
})
export class SafetyModule {}
