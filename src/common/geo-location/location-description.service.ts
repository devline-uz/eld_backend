import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DescribeOptions, describeLocation, getPlaceIndex, resolveLocationText } from './location-description';

/**
 * §395 Appendix A §4.4.2 — offline geo-location ("3mi W OH Columbus"). No external API at runtime:
 * the GeoNames-derived place grid is built ONCE at startup (`onModuleInit`) and shared process-wide
 * with the pure helpers in `location-description.ts`, which writers/mappers call directly.
 */
@Injectable()
export class LocationDescriptionService implements OnModuleInit {
  private readonly logger = new Logger(LocationDescriptionService.name);

  onModuleInit(): void {
    const started = Date.now();
    const index = getPlaceIndex();
    this.logger.log(`geo-location index ready: ${index.size} places in ${Date.now() - started} ms`);
  }

  describe(lat: unknown, lon: unknown, options: DescribeOptions = {}): string | null {
    return describeLocation(lat, lon, options);
  }

  resolve(supplied: string | null | undefined, lat: unknown, lon: unknown, options: DescribeOptions = {}): string | null {
    return resolveLocationText(supplied, lat, lon, options);
  }
}
