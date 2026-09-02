import { useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query currently matches, kept live.
 *
 * The readout authors its narrow-width copy and its folded seat rows in TSX
 * rather than duplicating the markup and hiding half of it, so the same
 * breakpoints the stylesheets use have to be readable from a component.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
