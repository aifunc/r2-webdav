import type { Env, SidecarConfig } from './types';

export const DEFAULT_SIDECAR_PREFIX = '.__sidecar__';
export const DEFAULT_SIDECAR_CONFIG = { sidecarPrefix: DEFAULT_SIDECAR_PREFIX };

export function getSidecarPrefix(sidecarConfig: SidecarConfig = DEFAULT_SIDECAR_CONFIG): string {
	return sidecarConfig.sidecarPrefix;
}

export function resolveSidecarConfig(env: Pick<Env, 'SIDECAR_PREFIX'> | { SIDECAR_PREFIX?: string }): SidecarConfig {
	let sidecarPrefix = env.SIDECAR_PREFIX?.replace(/^\/+|\/+$/g, '') || DEFAULT_SIDECAR_PREFIX;
	return { sidecarPrefix };
}
