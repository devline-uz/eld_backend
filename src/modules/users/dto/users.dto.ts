import { z } from 'zod';

export const CreateUserDto = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  jobTitle: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  roleId: z.string().uuid(),
  /** B-85 — terminal scope for the invited user. tz.md §20.4 question 2 (UI filter vs
   * security boundary) is still open (D-090): stored only, not yet enforced anywhere. */
  terminalIds: z.array(z.string().min(1)).max(50).optional(),
  /** B-85 — appended to the invite email; no outbound-mail transport exists yet (see
   * `AuthService.forgotPassword`), so this is logged the same way that flow's reset token is. */
  message: z.string().max(500).optional(),
});
export type CreateUserDto = z.infer<typeof CreateUserDto>;

export const UpdateUserDto = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  jobTitle: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']).optional(),
  /** B-84 — changing this does NOT touch `User.email` directly; see `UsersService.update`. */
  email: z.string().email().optional(),
  homeTerminalName: z.string().max(120).optional(),
});
export type UpdateUserDto = z.infer<typeof UpdateUserDto>;

export const UpdateMyProfileDto = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  jobTitle: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
});
export type UpdateMyProfileDto = z.infer<typeof UpdateMyProfileDto>;

/** B-11 — `GET/PUT /me/preferences`. Shape is **taxminiy** (backend_tasks.md §30): not
 * pinned down by tz.md, so kept intentionally permissive/partial rather than guessing a
 * rigid contract the web team would have to work around. */
export const PreferencesDto = z.object({
  language: z.string().max(20).optional(),
  timezone: z.string().max(60).optional(),
  dateFormat: z.string().max(30).optional(),
  distanceUnit: z.enum(['MILES', 'KM']).optional(),
  savedViews: z.record(z.string(), z.array(z.unknown())).optional(),
  tableColumns: z.record(z.string(), z.array(z.unknown())).optional(),
});
export type PreferencesDto = z.infer<typeof PreferencesDto>;
