import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateUserDto, UpdateUserDto } from './dto/users.dto';
import { Actor, UsersService } from './users.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §11.7 — back-office user CRUD, gated by the `users` permission key. */
@FigmaScreen('web/settings-users')
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Perm('users', 'READ')
  @ApiOperation({ summary: 'Lists back-office users with their role.' })
  @ApiOkResponse({ schema: { example: [{ id: 'usr_1', email: 'sarah.chen@universal-logistics.com', firstName: 'Sarah', lastName: 'Chen', status: 'ACTIVE', role: { key: 'ADMIN', name: 'Administrator' }, lastActiveAt: '2026-09-11T15:39:00.000Z' }] } })
  @ApiStandardErrors()
  list() {
    return this.users.list();
  }

  @Get(':id')
  @Perm('users', 'READ')
  @ApiOperation({ summary: 'Gets one back-office user.' })
  @ApiOkResponse({ schema: { example: { id: 'usr_1', email: 'sarah.chen@universal-logistics.com', firstName: 'Sarah', lastName: 'Chen', status: 'ACTIVE', role: { key: 'ADMIN', name: 'Administrator' } } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'User not found.')] })
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post()
  @Perm('users', 'FULL')
  @Audit({ object: 'User', action: 'INVITE' })
  @ApiOperation({ summary: 'Invites a new back-office user (TZ §18 — audited).' })
  @ApiOkResponse({ schema: { example: { user: { id: 'usr_1', status: 'INVITED' }, emailDelivered: true } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A user with this email already exists.')] })
  create(@Body(zodBody(CreateUserDto)) dto: CreateUserDto, @CurrentUser() actor: Actor) {
    return this.users.invite(dto, actor);
  }

  @Post(':id/resend-invite')
  @Perm('users', 'FULL')
  @Audit({ object: 'User', action: 'INVITE' })
  @ApiOperation({ summary: 'Re-sends the invite email and restarts the 7-day window for a user still in INVITED status.' })
  @ApiCreatedResponse({ schema: { example: { emailDelivered: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'User not found.'), apiError.conflict(ERROR_CODES.CONFLICT, 'User is not in INVITED status.')] })
  resendInvite(@Param('id') id: string, @CurrentUser() actor: Actor) {
    return this.users.resendInvite(id, actor);
  }

  @Patch(':id')
  @Perm('users', 'FULL')
  // Caps password guessing through the email-change re-auth (per principal), well above editing pace.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Audit({ object: 'User', action: 'UPDATE' })
  @ApiOperation({
    summary: 'Updates a user, including role assignment (TZ §18 — audited as a role change).',
    description:
      'B-84 — a changed `email` (after trim + lower-case) is NOT written: it becomes `pendingEmail`, a confirm link is mailed to it ' +
      '(valid `USER_EMAIL_CHANGE_TTL`, killed by a newer request or a cancel) and a "this wasn\'t me" notice to the old address. ' +
      'It requires the ACTING user\'s `currentPassword` (or `reauthIdToken` for a Google-only account) — 401 REAUTH_REQUIRED / ' +
      'REAUTH_FAILED with `details.currentPassword`. 409 EMAIL_TAKEN (`details.email`) when another user has the address or a ' +
      'pending change to it; 409 EMAIL_CHANGE_ON_HOLD inside the hold window of the previous change. The response then carries ' +
      '`emailVerification: { pendingEmail, emailDelivered, verifyToken? }` (`verifyToken` only with DEV_ECHO_SECRETS).',
  })
  @ApiOkResponse({ schema: { example: { id: 'usr_3', firstName: 'Dana', lastName: 'Ford', status: 'ACTIVE', email: 'dana.ford@example.com', pendingEmail: 'dana@new.example.com', role: { key: 'DISPATCHER', name: 'Dispatcher' }, emailVerification: { pendingEmail: 'dana@new.example.com', emailDelivered: true } } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'User not found.'),
      apiError.conflict(ERROR_CODES.EMAIL_TAKEN, 'A user with this email address already exists.'),
      { status: 401, code: ERROR_CODES.REAUTH_FAILED, message: 'Password is incorrect.' },
    ],
  })
  update(@Param('id') id: string, @Body(zodBody(UpdateUserDto)) dto: UpdateUserDto, @CurrentUser() actor: Actor) {
    return this.users.update(id, dto, actor);
  }

  @Post(':id/email-change/resend')
  @HttpCode(202)
  @Perm('users', 'FULL')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit({ object: 'User', action: 'EMAIL_CHANGE_RESEND' })
  @ApiOperation({ summary: 'B-84 — re-mails the confirm link of the pending email change (same request; the old-address cancel link stays valid).' })
  @ApiOkResponse({ schema: { example: { pendingEmail: 'new@example.com', emailedTo: 'new@example.com', emailDelivered: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.EMAIL_CHANGE_NOT_PENDING, 'This user has no pending email change.')] })
  resendEmailChange(@Param('id') id: string, @CurrentUser() actor: Actor) {
    return this.users.resendEmailChange(id, actor);
  }

  @Delete(':id/email-change')
  @Perm('users', 'FULL')
  @Audit({ object: 'User', action: 'EMAIL_CHANGE_CANCEL' })
  @ApiOperation({ summary: 'B-84 — cancels the pending email change; the current email stays and the emailed links stop working.' })
  @ApiOkResponse({ schema: { example: { id: 'usr_3', email: 'dana.ford@example.com', pendingEmail: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.EMAIL_CHANGE_NOT_PENDING, 'This user has no pending email change.')] })
  cancelEmailChange(@Param('id') id: string, @CurrentUser() actor: Actor) {
    return this.users.cancelEmailChange(id, actor);
  }

  @Delete(':id')
  @Perm('users', 'FULL')
  @Audit({ object: 'User', action: 'DELETE' })
  @ApiOperation({ summary: 'Deletes a back-office user.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'User not found.')] })
  async remove(@Param('id') id: string, @CurrentUser() actor: Actor) {
    await this.users.remove(id, actor);
    return { success: true };
  }
}
