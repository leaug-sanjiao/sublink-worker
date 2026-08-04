import { createApp } from './app/createApp.jsx';
import { createCloudflareRuntime } from './runtime/cloudflare.js';

let honoApp;
const AUTH_COOKIE = 'sublink_auth';

function getApp(env) {
  if (!honoApp) {
    honoApp = createApp(createCloudflareRuntime(env));
  }
  return honoApp;
}

function sameToken(candidate, expected) {
  if (
    typeof candidate !== 'string' ||
    typeof expected !== 'string' ||
    candidate.length !== expected.length
  ) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

function readCookie(request) {
  const prefix = `${AUTH_COOKIE}=`;
  const cookies = request.headers.get('Cookie') || '';

  for (const item of cookies.split(';')) {
    const cookie = item.trim();
    if (cookie.startsWith(prefix)) {
      return cookie.slice(prefix.length);
    }
  }

  return '';
}

function presentedToken(request, url) {
  const queryToken = url.searchParams.get('token');
  const authorization = request.headers.get('Authorization') || '';
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  return queryToken || bearerToken || readCookie(request);
}

function authCookie(token) {
  return `${AUTH_COOKIE}=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`;
}

function errorResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'WWW-Authenticate': 'Bearer',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const expectedToken = env.ACCESS_TOKEN;

    if (!expectedToken) {
      return errorResponse('ACCESS_TOKEN is not configured', 503);
    }

    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');

    if (!sameToken(presentedToken(request, url), expectedToken)) {
      return errorResponse('Unauthorized', 401);
    }

    if (queryToken && url.pathname === '/') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.origin}/`,
          'Set-Cookie': authCookie(expectedToken),
          'Cache-Control': 'no-store',
        },
      });
    }

    if (queryToken) {
      url.searchParams.delete('token');
      request = new Request(url.toString(), request);
    }

    const response = await getApp(env).fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');

    if (queryToken) {
      headers.append('Set-Cookie', authCookie(expectedToken));

      const location = headers.get('Location');
      if (location && response.status >= 300 && response.status < 400) {
        const redirectUrl = new URL(location, url.origin);

        if (redirectUrl.origin === url.origin) {
          redirectUrl.searchParams.set('token', expectedToken);
          headers.set('Location', redirectUrl.toString());
        }
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
