import '@testing-library/jest-dom/vitest';
import { act, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout. React Flow measures nodes (and their handles) before it draws edges, so
// every element gets a fixed size, reported once when it is observed.
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
  m22: number;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? '')?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}
globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;

Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { get: () => 200, configurable: true },
  offsetHeight: { get: () => 100, configurable: true },
});
HTMLElement.prototype.getBoundingClientRect = function () {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  };
};
// React Flow's click-to-connect looks for a handle under the pointer, then falls back to the
// clicked handle.
document.elementFromPoint = () => null;

(SVGElement.prototype as SVGGraphicsElement).getBBox = () => new DOMRect(0, 0, 80, 16);

afterEach(() => {
  cleanup();
});
