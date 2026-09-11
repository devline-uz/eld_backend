import { z } from 'zod';

export const CreateUserDto = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  jobTitle: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  roleId: z.string().uuid(),
});
export type CreateUserDto = z.infer<typeof CreateUserDto>;

export const UpdateUserDto = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  jobTitle: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']).optional(),
});
export type UpdateUserDto = z.infer<typeof UpdateUserDto>;

export const UpdateMyProfileDto = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  phone: z.string().max(30).optional(),
});
export type UpdateMyProfileDto = z.infer<typeof UpdateMyProfileDto>;
