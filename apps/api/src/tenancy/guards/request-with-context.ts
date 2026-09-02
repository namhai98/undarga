import type { Request } from 'express';
import type { RequestContext } from '../context/context.types';

/**
 * Guards write the resolved context onto the request as well as into
 * AsyncLocalStorage.
 *
 * ALS is the source of truth for services; this copy exists only because
 * `createParamDecorator` factories run outside DI and so cannot reach
 * RequestContextService. The two are written together and never diverge.
 */
export const REQUEST_CONTEXT_KEY = '__undargaContext' as const;

export type RequestWithContext = Request & {
  [REQUEST_CONTEXT_KEY]?: RequestContext;
  requestId?: string;
  /**
   * The active-company claim, copied here by JwtAuthGuard from the
   * signature-verified token.
   *
   * Carried out-of-band rather than left in a header so that no caller can
   * forge it: only code holding a verified token writes this field.
   */
  verifiedActiveCompanyId?: string;
};
