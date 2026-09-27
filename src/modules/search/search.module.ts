import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';

/** TZ §11.28 — 11.28 command-palette global search (§20 B-10). */
@Module({
  controllers: [SearchController],
  providers: [SearchService, SearchRepository],
})
export class SearchModule {}
