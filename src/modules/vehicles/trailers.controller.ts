import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateTrailerDto, ImportTrailersDto, UpdateTrailerDto } from './dto/vehicles.dto';
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
  @ApiOperation({ summary: 'Lists trailers.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'trl_1', number: 'T-4471', vin: '1JJV532W7YL123456', licensePlate: 'TRL-9921', licenseState: 'OH' }] } } })
  @ApiStandardErrors()
  list() {
    return this.trailers.list();
  }

  @Get('export')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Exports all trailers as the same shape `POST /trailers/import` accepts.' })
  @ApiOkResponse({ description: 'Every trailer in the import payload shape.', schema: { example: { trailers: [{ number: 'T-4471', vin: '1JJV532W7YL123456', licensePlate: 'TRL-9921', licenseState: 'OH' }] } } })
  @ApiStandardErrors()
  export() {
    return this.trailers.exportAll();
  }

  @Get(':id')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Gets one trailer.' })
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
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A trailer with this number already exists.')] })
  create(@Body(zodBody(CreateTrailerDto)) dto: CreateTrailerDto) {
    return this.trailers.create(dto);
  }

  @Post('import')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'IMPORT' })
  @ApiOperation({ summary: 'Bulk-imports trailers; upserts by `number`.' })
  @ApiCreatedResponse({ schema: { example: { imported: 2, updated: 0, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportTrailersDto)) dto: ImportTrailersDto) {
    return this.trailers.importMany(dto);
  }

  @Patch(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a trailer.' })
  @ApiOkResponse({ schema: { example: { id: 'trl_1', number: 'T-4471', licensePlate: 'TRL-9922' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trailer not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateTrailerDto)) dto: UpdateTrailerDto) {
    return this.trailers.update(id, dto);
  }

  @Delete(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Trailer', action: 'DELETE' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiOperation({ summary: 'Deletes a trailer.' })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trailer not found.')] })
  async remove(@Param('id') id: string) {
    await this.trailers.remove(id);
    return { success: true };
  }
}
