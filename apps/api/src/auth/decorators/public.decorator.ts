import { SetMetadata } from '@nestjs/common';
import { META_IS_PUBLIC, META_TOKEN_REALM } from '../../common/decorators/metadata';
import type { TokenRealm } from '../token.types';

/**
 * Skip authentication entirely.
 *
 * Implies @NoTenant(): there is no actor, so there can be no membership and no
 * tenant context. A public route that needs a company (the booking page) must
 * resolve it from the hostname and treat it as untrusted display context only.
 */
export const Public = () => SetMetadata(META_IS_PUBLIC, true);

/**
 * Which token audience this route accepts. Defaults to 'staff'.
 *
 * The three realms are mutually exclusive by design: a customer token
 * presented to a staff route is rejected on audience alone, before any
 * permission is consulted. That closes a whole class of escalation bug for the
 * cost of one claim.
 */
export const Realm = (realm: TokenRealm) => SetMetadata(META_TOKEN_REALM, realm);
