import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { EntitlementsService } from './entitlements.service';
import type { FeatureKey } from './plan-catalog';

export const META_REQUIRED_FEATURE = 'undarga:required-feature';

/**
 * Declare that a route (or every route of a controller) needs a plan feature.
 *
 *     @RequireFeature('GIFT_CARDS')
 *     export class GiftCardsController { … }
 *
 * The declaration is the only thing a controller does about plans. The check
 * is `FeatureGuard`, and the answer is `EntitlementsService`.
 */
export const RequireFeature = (feature: FeatureKey) => SetMetadata(META_REQUIRED_FEATURE, feature);

/**
 * Runs after PermissionGuard: who you are and what your role allows are
 * settled first, then whether the company's plan includes the feature. A
 * refusal is 403 FEATURE_NOT_AVAILABLE with the feature and plan named.
 *
 * Routes without a tenant (public, platform) have no plan to consult and pass.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContextService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      META_REQUIRED_FEATURE,
      [execution.getHandler(), execution.getClass()],
    );
    if (!feature) return true;

    const tenant = this.context.tenantOrNull();
    if (!tenant) return true;

    await this.entitlements.assertFeature(tenant.company.id, feature);
    return true;
  }
}
