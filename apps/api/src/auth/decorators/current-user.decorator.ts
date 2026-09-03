import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type {
  Actor,
  CompanyUserActor,
  PlatformUserActor,
} from '../../tenancy/context/context.types';
import {
  REQUEST_CONTEXT_KEY,
  type RequestWithContext,
} from '../../tenancy/guards/request-with-context';

function actorOf(ctx: ExecutionContext): Actor | null {
  const request = ctx.switchToHttp().getRequest<RequestWithContext>();
  return request[REQUEST_CONTEXT_KEY]?.actor ?? null;
}

/** The authenticated actor, whichever realm it came from. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor | null => actorOf(ctx),
);

/** Narrowed to a company user. Null if the caller is not one. */
export const CurrentCompanyUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CompanyUserActor | null => {
    const actor = actorOf(ctx);
    return actor?.kind === 'COMPANY_USER' ? actor : null;
  },
);

/** Narrowed to a platform operator. Null if the caller is not one. */
export const CurrentPlatformUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformUserActor | null => {
    const actor = actorOf(ctx);
    return actor?.kind === 'PLATFORM_USER' ? actor : null;
  },
);
