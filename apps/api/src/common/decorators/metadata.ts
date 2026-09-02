/**
 * Every reflection key in one place.
 *
 * Guards read these; decorators write them. Keeping them together stops the
 * classic bug where a decorator sets `isPublic` and a guard checks `IS_PUBLIC`
 * and the route is silently unprotected.
 */
export const META_IS_PUBLIC = 'undarga:isPublic';
export const META_TOKEN_REALM = 'undarga:tokenRealm';
export const META_NO_TENANT = 'undarga:noTenant';
export const META_ALLOW_PLATFORM_ACCESS = 'undarga:allowPlatformAccess';
export const META_REQUIRED_PERMISSIONS = 'undarga:requiredPermissions';
export const META_PERMISSION_MODE = 'undarga:permissionMode';
export const META_PLATFORM_ONLY = 'undarga:platformOnly';
export const META_REQUIRED_PLATFORM_PERMISSIONS = 'undarga:requiredPlatformPermissions';
export const META_REQUIRES_WRITE = 'undarga:requiresWrite';
