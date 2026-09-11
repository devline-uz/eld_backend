import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'onebook:public';

/** Marks a route as reachable without a JWT (login, health, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
