import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto';
import { RolesService } from './roles.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §6.4 / §11.7 — role CRUD, gated by the `roles` permission key (ADMIN-only by default). */
@FigmaScreen('web/settings-roles-permissions')
@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Perm('roles', 'READ')
  @ApiOperation({ summary: 'Lists all roles, including the 4 system roles.' })
  @ApiOkResponse({ schema: { example: [{ key: 'ADMIN', isSystem: true, permissions: {}, userCount: 1 }] } })
  @ApiStandardErrors()
  list() {
    return this.roles.list();
  }

  @Get(':id')
  @Perm('roles', 'READ')
  @ApiOperation({ summary: 'Gets one role by id.' })
  @ApiOkResponse({ schema: { example: { id: 'rol_1', key: 'DISPATCHER', name: 'Dispatcher', isSystem: true, permissions: { vehicles: 'READ', drivers: 'READ', logs: 'READ', reportsTransfer: 'NONE' } } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Role not found.')] })
  get(@Param('id') id: string) {
    return this.roles.get(id);
  }

  @Post()
  @Perm('roles', 'FULL')
  @Audit({ object: 'Role', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a custom role with a full 22-key permission matrix.' })
  @ApiCreatedResponse({ schema: { example: { id: 'rol_9', key: 'SAFETY_REVIEWER', name: 'Safety reviewer', isSystem: false, permissions: { logs: 'READ', safety: 'FULL' } } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A role with this key already exists.')] })
  create(@Body(zodBody(CreateRoleDto)) dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @Patch(':id')
  @Perm('roles', 'FULL')
  @Audit({ object: 'Role', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a custom role. ADMIN (isSystem) cannot be edited.' })
  @ApiOkResponse({ schema: { example: { id: 'rol_9', key: 'SAFETY_REVIEWER', name: 'Safety reviewer', isSystem: false, permissions: { logs: 'READ', safety: 'READ' } } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Role not found.'), apiError.conflict(ERROR_CODES.ROLE_IMMUTABLE, 'System roles cannot be edited or deleted (Figma: "Admin cannot be edited").')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateRoleDto)) dto: UpdateRoleDto, @CurrentUser() actor: { role?: string }) {
    return this.roles.update(id, dto, actor);
  }

  @Delete(':id')
  @Perm('roles', 'FULL')
  @Audit({ object: 'Role', action: 'DELETE' })
  @ApiOperation({ summary: 'Deletes a custom role. ADMIN (isSystem) cannot be deleted.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Role not found.'), apiError.conflict(ERROR_CODES.ROLE_IMMUTABLE, 'System roles cannot be edited or deleted (Figma: "Admin cannot be edited").')] })
  async remove(@Param('id') id: string) {
    await this.roles.remove(id);
    return { success: true };
  }
}
