import { Body, Controller, Delete, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from '../auth/auth.service';
import { UpdateMyProfileDto } from './dto/users.dto';
import { UsersService } from './users.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

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
  @ApiOperation({ summary: "Lists the current user's active sessions." })
  @ApiOkResponse({ description: 'Active sessions — the "My profile → Active sessions" panel.', schema: { example: [{ id: 'ses_1', ip: '10.14.2.88', userAgent: 'Chrome/140 macOS', createdAt: '2026-09-11T08:12:00.000Z', lastUsedAt: '2026-09-11T15:39:00.000Z', current: true }] } })
  @ApiStandardErrors()
  sessions(@CurrentUser('id') id: string) {
    return this.auth.listUserSessions(id);
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: "Revokes one of the current user's sessions." })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Session not found for this user.')] })
  async revokeSession(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.auth.revokeUserSession(userId, id);
    return { success: true };
  }
}
