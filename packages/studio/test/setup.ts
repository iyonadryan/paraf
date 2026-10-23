import '@testing-library/jest-dom/vitest';
import { act, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// UI tests run in jsdom (see their @vitest-environment comment); server tests run in Node.
if (typeof window !== 'undefined') {
  // jsdom has no layout. React Flow measures nodes before it draws edges, so every element
  // gets a fixed size, reported once when it is observed.
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => {
        act(() => {
          this.callback(
            [{ target, contentRect: new DOMRect(0, 0, 1000, 800) } as ResizeObserverEntry],
            this,
          );
        });
      });
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;

  class DOMMatrixReadOnlyStub {
    m22 = 1;
  }
  globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;

  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get: () => 200, configurable: true },
    offsetHeight: { get: () => 100, configurable: true },
  });
  HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
  document.elementFromPoint = () => null;
  (SVGElement.prototype as SVGGraphicsElement).getBBox = () => new DOMRect(0, 0, 80, 16);

  afterEach(() => {
    cleanup();
  });
}
