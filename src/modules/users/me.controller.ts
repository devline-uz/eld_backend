import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from '../auth/auth.service';
import { PreferencesDto, UpdateMyProfileDto } from './dto/users.dto';
import { AVATAR_MAX_BYTES, UsersService } from './users.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** No `@types/multer` in the dependency tree — this mirrors the subset of
 * `Express.Multer.File` `memoryStorage()` actually produces, without depending on that
 * package's ambient types. */
interface UploadedMulterFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** TZ §11.7 `/me/*` — the caller's own profile, sessions and session revocation. */
@FigmaScreen('web/my-profile')
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'The current user profile.' })
  @ApiOkResponse({ schema: { example: { id: 'usr_1', email: 'sarah.chen@universal-logistics.com', firstName: 'Sarah', lastName: 'Chen', phone: '+13347654888', role: { key: 'ADMIN', name: 'Administrator' } } } })
  @ApiStandardErrors()
  profile(@CurrentUser('id') id: string) {
    return this.users.get(id);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Updates the current user profile (name/phone only — not role).' })
  @ApiOkResponse({ schema: { example: { id: 'usr_1', firstName: 'Sarah', lastName: 'Chen', phone: '+13347654999' } } })
  @ApiStandardErrors()
  updateProfile(@CurrentUser('id') id: string, @Body(zodBody(UpdateMyProfileDto)) dto: UpdateMyProfileDto) {
    return this.users.updateMyProfile(id, dto);
  }

  @Get('sessions')
  @ApiOperation({ summary: "Lists the current user's active sessions (B-50 — no refreshHash/userId ever leaves this endpoint)." })
  @ApiOkResponse({ description: 'Active sessions — the "My profile → Active sessions" panel.', schema: { example: [{ id: 'ses_1', deviceLabel: null, ip: '10.14.2.88', userAgent: 'Chrome/140 macOS', location: null, lastSeenAt: '2026-09-11T15:39:00.000Z', current: true }] } })
  @ApiStandardErrors()
  sessions(@CurrentUser('id') id: string, @CurrentUser('sessionId') sessionId?: string) {
    return this.auth.listUserSessions(id, sessionId);
  }

  @Delete('sessions')
  @ApiOperation({ summary: "Signs the current user out of every other active session (\"Sign out everywhere\", B-50)." })
  @ApiOkResponse({ schema: { example: { revoked: 3 } } })
  @ApiStandardErrors()
  async revokeAllSessions(@CurrentUser('id') userId: string, @CurrentUser('sessionId') sessionId?: string) {
    const revoked = await this.auth.revokeAllUserSessions(userId, sessionId);
    return { revoked };
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: "Revokes one of the current user's sessions." })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Session not found for this user.')] })
  async revokeSession(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.auth.revokeUserSession(userId, id);
    return { success: true };
  }

  @Post('avatar')
  // B-095 — multer buffers the whole part in memory before the service's size check ever runs;
  // the limit must be enforced while streaming (413 past 5 MB), not after.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 5, parts: 6 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'B-51 — uploads the profile avatar (PNG/JPG, >= 256x256).' })
  @ApiOkResponse({ schema: { example: { id: 'usr_1', avatarUrl: 'https://minio.local/onebook-eld/avatars/usr_1/...' } } })
  @ApiStandardErrors({
    errors: [
      apiError.unprocessable(ERROR_CODES.UNSUPPORTED_FILE_TYPE, 'Avatar must be a PNG or JPG image.'),
      apiError.unprocessable(ERROR_CODES.IMAGE_TOO_SMALL, 'Avatar must be at least 256x256px.'),
      { status: 422, code: ERROR_CODES.FILE_TOO_LARGE, message: 'Avatar exceeds the upload size limit.' },
    ],
  })
  uploadAvatar(@CurrentUser('id') id: string, @UploadedFile() file: UploadedMulterFile | undefined) {
    return this.users.uploadAvatar(id, file);
  }

  @Delete('avatar')
  @ApiOperation({ summary: 'B-51 — removes the profile avatar.' })
  @ApiOkResponse({ schema: { example: { id: 'usr_1', avatarUrl: null } } })
  @ApiStandardErrors()
  deleteAvatar(@CurrentUser('id') id: string) {
    return this.users.deleteAvatar(id);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'B-11 — the current user\'s UI preferences (language, timezone, saved views, table columns).' })
  @ApiOkResponse({ schema: { example: { language: 'en', timezone: 'America/Chicago', dateFormat: 'MMM D, YYYY', distanceUnit: 'MILES', savedViews: {}, tableColumns: {} } } })
  @ApiStandardErrors()
  getPreferences(@CurrentUser('id') id: string) {
    return this.users.getPreferences(id);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'B-11 — replaces the current user\'s UI preferences.' })
  @ApiOkResponse({ schema: { example: { language: 'en', timezone: 'America/Chicago', dateFormat: 'MMM D, YYYY', distanceUnit: 'MILES' } } })
  @ApiStandardErrors()
  updatePreferences(@CurrentUser('id') id: string, @Body(zodBody(PreferencesDto)) dto: PreferencesDto) {
    return this.users.updatePreferences(id, dto);
  }
}
