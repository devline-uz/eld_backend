import { Module } from '@nestjs/common';
import { GeofencesController } from './geofences.controller';
import { GeofencesRepository } from './geofences.repository';
import { GeofencesService } from './geofences.service';

/** TZ §11.5 — Live Fleet map geofences. */
@Module({
  controllers: [GeofencesController],
  providers: [GeofencesService, GeofencesRepository],
  exports: [GeofencesService, GeofencesRepository],
})
export class GeofencesModule {}
