import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
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
  @Audit({ object: 'User', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a user, including role assignment (TZ §18 — audited as a role change).' })
  @ApiOkResponse({ schema: { example: { id: 'usr_3', firstName: 'Dana', lastName: 'Ford', status: 'ACTIVE', role: { key: 'DISPATCHER', name: 'Dispatcher' } } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'User not found.'), apiError.conflict(ERROR_CODES.ROLE_IMMUTABLE, 'The ADMIN system role cannot be reassigned away from the last administrator.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateUserDto)) dto: UpdateUserDto, @CurrentUser() actor: Actor) {
    return this.users.update(id, dto, actor);
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
