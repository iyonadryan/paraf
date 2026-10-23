import { useEffect, useState } from 'react';

/** Pages of the studio, addressed by the URL hash so the server needs a single page. */
export type Route = { page: 'flows' } | { page: 'flow'; id: string } | { page: 'new' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/new') return { page: 'new' };
  const match = /^\/flows\/(.+)$/.exec(path);
  return match?.[1] ? { page: 'flow', id: decodeURIComponent(match[1]) } : { page: 'flows' };
}

export function hrefOf(route: Route): string {
  if (route.page === 'flow') return `#/flows/${encodeURIComponent(route.id)}`;
  return route.page === 'new' ? '#/new' : '#/';
}

/** The current route; follows the back and forward buttons. */
export function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return parseRoute(hash);
}

export function navigate(route: Route): void {
  window.location.hash = hrefOf(route);
}
