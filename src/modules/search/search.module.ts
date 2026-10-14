import { Module } from '@nestjs/common';
import { ViolationsModule } from '../violations/violations.module';
import { SearchController } from './search.controller';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';

/** TZ §11.28 — 11.28 command-palette global search (§20 B-10). */
@Module({
  imports: [ViolationsModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRepository],
})
export class SearchModule {}
