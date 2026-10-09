import { Body, Controller, Delete, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { DefectCatalogItemResponse, DeletedResponse, SavedSignatureResponse } from './dto/mobile.responses';
import { DefectCatalogQueryDto, SavedSignatureDto } from './dto/mobile.dto';
import { MobileCatalogRepository } from './mobile-catalog.repository';
import { MobileSavedSignatureService } from './mobile-saved-signature.service';

/**
 * MR-9 — `GET /mobile/defect-catalog` (DVIR add-defect picker, screens M-13/M-14) and
 * MR-27 — `GET/PUT/DELETE /mobile/saved-signature` (signature pad "use saved signature").
 * Driver token only (`DriverGuard`), not RBAC.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileCatalogController {
  constructor(
    private readonly catalog: MobileCatalogRepository,
    private readonly saved: MobileSavedSignatureService,
  ) {}

  @Get('defect-catalog')
  @ApiOperation({
    summary: 'MR-9 — DVIR defect catalog (FMCSA 49 CFR 396.11 truck / trailer inspection items).',
    description:
      '`code` is stable and unique per `part`; send it as `defects[].category` in `POST /mobile/dvir`. `critical` is a hint that a defect on this ' +
      'item is typically out-of-service class — the driver still picks the defect `severity`. Unknown categories are still accepted by the DVIR ' +
      'submit (lenient, for older app builds that send the English item name). M-29: the list is the design\'s (rows verbatim, in design order); `isPhoto` marks the ' +
      '"Accident Photo" row — a photo capture, not an inspection item.',
  })
  @ApiQuery({ name: 'part', required: false, enum: ['TRUCK', 'TRAILER'], description: 'Omit to get both parts.' })
  @ApiEnvelopeResponse(DefectCatalogItemResponse, {
    isArray: true,
    example: [{ code: 'ACCIDENT_PHOTO', name: 'Accident Photo', part: 'TRUCK', category: 'Accident', critical: false, isPhoto: true }, { code: 'BRAKES_SERVICE', name: 'Brakes, Service', part: 'TRUCK', category: 'Brakes', critical: true, isPhoto: false }],
  })
  @ApiStandardErrors()
  async defectCatalog(@Query(zodBody(DefectCatalogQueryDto)) query: DefectCatalogQueryDto) {
    const rows = await this.catalog.listCatalog(query.part);
    return rows.map((row) => ({ code: row.code, name: row.name, part: row.part, category: row.category, critical: row.critical, isPhoto: row.isPhoto }));
  }

  @Get('saved-signature')
  @ApiOperation({ summary: 'MR-27 — the driver\'s saved signature (presigned 15 min URL), or `null` when none is saved.' })
  @ApiEnvelopeResponse(SavedSignatureResponse, {
    nullable: true,
    description: '`data` is null when no signature is saved.',
    example: { signatureImageId: '3f2c...', key: 'signatures/drv_1/3f2c.png', url: 'https://...', mimeType: 'image/png', sizeBytes: 4821, sha256: 'a1b2...', updatedAt: '2026-10-08T12:00:00.000Z' },
  })
  @ApiStandardErrors()
  get(@CurrentUser('id') driverId: string) {
    return this.saved.get(driverId);
  }

  @Put('saved-signature')
  @ApiOperation({
    summary: 'MR-27 — saves (replaces) the driver\'s signature: base64 bytes + mime, or an existing `signatureImageId` from `POST /mobile/signature`.',
    description: 'Exactly one of `signatureBase64` / `signatureImageId`. PNG/JPEG, max 2 MB. Idempotent on `clientId` (409 when that id was spent on another operation).',
  })
  @ApiBody({ schema: { example: { signatureBase64: 'iVBORw0KGgo...', mimeType: 'image/png', clientId: '7d1c2a40-0000-4000-8000-000000000001' } } })
  @ApiEnvelopeResponse(SavedSignatureResponse, { example: { signatureImageId: '3f2c...', key: 'signatures/drv_1/3f2c.png', url: 'https://...', mimeType: 'image/png', sizeBytes: 4821, sha256: 'a1b2...', updatedAt: '2026-10-08T12:00:00.000Z' } })
  @ApiStandardErrors({
    errors: [
      apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Neither/both of signatureBase64 and signatureImageId, an empty payload, or an unknown signatureImageId.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'clientId already used by another operation.'),
    ],
  })
  put(@Body(zodBody(SavedSignatureDto)) dto: SavedSignatureDto, @CurrentUser('id') driverId: string) {
    return this.saved.put(driverId, dto);
  }

  @Delete('saved-signature')
  @ApiOperation({ summary: 'MR-27 — forgets the saved signature (idempotent; the stored object is kept, earlier DVIRs may reference it).' })
  @ApiEnvelopeResponse(DeletedResponse, { description: '`deleted: false` when nothing was saved.', example: { deleted: true } })
  @ApiStandardErrors()
  remove(@CurrentUser('id') driverId: string) {
    return this.saved.remove(driverId);
  }
}
