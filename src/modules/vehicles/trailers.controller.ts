import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateTrailerDto, ImportTrailersDto, TrailerListQueryDto, UpdateTrailerDto } from './dto/vehicles.dto';
import { TrailersService } from './trailers.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §5.3 — trailer inventory, part of the "Vehicles" Figma screen's unit inventory; gated by `vehicles`. */
@FigmaScreen('web/vehicles')
@ApiTags('trailers')
@ApiBearerAuth()
@Controller('trailers')
export class TrailersController {
  constructor(private readonly trailers: TrailersService) {}

  @Get()
  @Perm('vehicles', 'READ')
  @ApiQuery({ name: 'page', required: false, description: '1-based page number (default 1).' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size, 1–200 (default 25).' })
  @ApiQuery({ name: 'sort', required: false, description: '`number|vin|status` + `:asc|:desc` (default `number:asc`).' })
  @ApiQuery({ name: 'q', required: false, description: 'Case-insensitive substring match on trailer number or VIN.' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE', 'OUT_OF_SERVICE'] })
  @ApiOperation({ summary: 'Lists live (not deleted) trailers, paginated like `GET /vehicles`.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'trl_1', number: 'T-4471', vin: '1JJV532W7YL123456', status: 'ACTIVE', deletedAt: null }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(TrailerListQueryDto)) query: TrailerListQueryDto) {
    return this.trailers.list(query);
  }

  @Get('export')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Exports all live (not deleted) trailers as the same shape `POST /trailers/import` accepts.' })
  @ApiOkResponse({ description: 'Every trailer in the import payload shape.', schema: { example: { trailers: [{ number: 'T-4471', vin: '1JJV532W7YL123456', licensePlate: 'TRL-9921', licenseState: 'OH' }] } } })
  @ApiStandardErrors()
  export() {
    return this.trailers.exportAll();
  }

  @Get(':id')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Gets one live trailer (a soft-deleted trailer is a 404).' })
  @ApiOkResponse({ schema: { example: { id: 'trl_1', number: 'T-4471', vin: '1JJV532W7YL123456', licensePlate: 'TRL-9921', licenseState: 'OH' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trailer not found.')] })
  get(@Param('id') id: string) {
    return this.trailers.get(id);
  }

  @Post()
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'CREATE' })
  @ApiOperation({ summary: 'Adds a trailer.' })
  @ApiCreatedResponse({ schema: { example: { id: 'trl_9', number: 'T-4480', licensePlate: 'TRL-1180', licenseState: 'OH' } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A live trailer with this number already exists (a deleted trailer\'s number is reusable).')] })
  create(@Body(zodBody(CreateTrailerDto)) dto: CreateTrailerDto) {
    return this.trailers.create(dto);
  }

  @Post('import')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'IMPORT' })
  @ApiOperation({ summary: 'Bulk-imports trailers; upserts by `number` among live trailers (a number held only by a deleted trailer creates a new one).' })
  @ApiCreatedResponse({ schema: { example: { imported: 2, updated: 0, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportTrailersDto)) dto: ImportTrailersDto) {
    return this.trailers.importMany(dto);
  }

  @Patch(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a live trailer (a soft-deleted trailer is a 404).' })
  @ApiOkResponse({ schema: { example: { id: 'trl_1', number: 'T-4471', vin: '1JJV532W7YL123456', status: 'ACTIVE', deletedAt: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trailer not found.'), apiError.conflict(ERROR_CODES.CONFLICT, 'A live trailer with this number already exists.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateTrailerDto)) dto: UpdateTrailerDto) {
    return this.trailers.update(id, dto);
  }

  @Delete(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'DELETE' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiOperation({ summary: 'Soft-deletes a trailer: hidden from list/lookup/export and no longer assignable, its number is freed for reuse, historical DVIRs/trips keep resolving it. Deleting an already-deleted trailer is a 404.' })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trailer not found.')] })
  async remove(@Param('id') id: string) {
    await this.trailers.remove(id);
    return { success: true };
  }
}
