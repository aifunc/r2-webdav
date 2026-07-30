import { getAuthorizedUsers, isAuthorized } from '../domain/auth';
import { resolveSidecarConfig } from '../shared/sidecar';
import { CORS_ALLOW_HEADERS, CORS_EXPOSE_HEADERS, SUPPORT_METHODS } from '../shared/constants';
import type { Env } from '../shared/types';
import { dispatchHandler } from './dispatch';

function applyCorsHeaders(request: Request, response: Response): Response {
	response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
	for (const [name, value] of Object.entries({
		'Access-Control-Allow-Methods': SUPPORT_METHODS.join(', '),
		'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS.join(', '),
		'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS.join(', '),
		'Access-Control-Allow-Credentials': 'false',
		'Access-Control-Max-Age': '86400',
	})) {
		response.headers.set(name, value);
	}
	return response;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (
			request.method !== 'OPTIONS' &&
			!(await isAuthorized(request.headers.get('Authorization') ?? '', getAuthorizedUsers(env)))
		) {
			await scheduler.wait(1000);
			return applyCorsHeaders(
				request,
				new Response('Unauthorized', {
					status: 401,
					headers: {
						'WWW-Authenticate': 'Basic realm="webdav"',
					},
				}),
			);
		}

		let response = await dispatchHandler(request, env.bucket, resolveSidecarConfig(env));
		return applyCorsHeaders(request, response);
	},
};
