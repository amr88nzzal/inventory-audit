import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);
afterEach(cleanup);

// jsdom لا يوفّر هذه الواجهات التي يحتاجها Mantine. jsdom lacks these APIs that Mantine needs.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
class ResizeObserverStub {
  observe = (): void => undefined;
  unobserve = (): void => undefined;
  disconnect = (): void => undefined;
}
globalThis.ResizeObserver = ResizeObserverStub;
Object.defineProperty(document, 'fonts', {
  value: { ready: Promise.resolve(), addEventListener: () => undefined },
});
