import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiStandardErrors } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { PermAny } from '../../common/decorators/perm.decorator';
import type { ContextUser } from '../../core/context/request-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { SearchQueryDto } from './dto/search.dto';
import { SearchService } from './search.service';

/** TZ §11.28 — the command palette's global search, reachable from the topbar on every
 * `web/fleet-dashboard`-rooted screen (no dedicated Figma page of its own). No dedicated §6.4
 * key exists, so the route needs `drivers` OR `vehicles` READ (driver tokens / scope-less API
 * keys get 403), and `SearchService` searches only the sections the caller may read
 * (bugs.md B-090 — it used to be ungated and returned every driver and vehicle). */
@FigmaScreen('web/fleet-dashboard')
@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @PermAny(['drivers', 'READ'], ['vehicles', 'READ'])
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Global driver + vehicle search for the command palette.' })
  @ApiOkResponse({ schema: { example: { q: 'smith', drivers: [{ id: 'drv_1', name: 'John Smith' }], vehicles: [] } } })
  @ApiStandardErrors()
  search(@Query(zodBody(SearchQueryDto)) query: SearchQueryDto, @CurrentUser() actor: ContextUser) {
    return this.searchService.search(query.q, query.limit, actor);
  }
}
