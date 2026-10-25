// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for Excalidraw with the trait that matters: it reports a change after every render of
// its own (componentDidUpdate), whether or not the scene changed.
const changes = vi.hoisted(() => ({ count: 0, throwOnRender: false }));
const scene = vi.hoisted(() => ({ api: null as null | { getSceneElements: () => unknown[] } }));
vi.mock('./ExcalidrawCanvas', async () => {
  const { Component } = await import('react');
  class FakeCanvas extends Component<{ onChange: (elements: unknown[]) => void; onApi: (api: unknown) => void }> {
    elements: unknown[] = [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 2, isDeleted: false }];
    componentDidMount() {
      const api = {
        getSceneElements: () => this.elements,
        getSceneElementsIncludingDeleted: () => this.elements,
        updateScene: ({ elements }: { elements?: unknown[] }) => {
          if (elements) this.elements = elements;
        },
        getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } }),
        scrollToContent: () => {},
      };
      scene.api = api;
      this.props.onApi(api);
      changes.count += 1;
      this.props.onChange(this.elements);
    }
    componentDidUpdate() {
      changes.count += 1;
      this.props.onChange(this.elements);
    }
    render() {
      if (changes.throwOnRender) throw new Error('canvas blew up');
      return <div data-testid="canvas" />;
    }
  }
  type FakeApi = { getSceneElements: () => unknown[]; updateScene: (s: { elements?: unknown[] }) => void };
  // The pen's host over the fake canvas (the real one is ExcalidrawCanvas.tsx penHost).
  const penHost = (api: FakeApi) => ({
    getElements: () => api.getSceneElements(),
    commit: (next: unknown[]) => api.updateScene({ elements: next }),
    toViewport: (p: unknown) => p,
    fit: async () => {},
    fitAll: async () => {},
  });
  const findBox = (api: FakeApi, label: string) => {
    const text = api.getSceneElements().find((e) => (e as { type: string; text?: string }).type === 'text' && (e as { text?: string }).text?.toLowerCase() === label.toLowerCase()) as { containerId?: string } | undefined;
    return text?.containerId ?? null;
  };
  let n = 0;
  const buildBox = (_api: FakeApi, label: string, author?: string) => {
    const id = `b${++n}`;
    return {
      id,
      elements: [
        { id, type: 'rectangle', x: 200 * n, y: 0, width: 160, height: 64, version: 1, customData: { author } },
        { id: `t${n}`, type: 'text', x: 200 * n + 10, y: 20, width: 140, height: 24, version: 1, text: label, originalText: label, containerId: id, fontSize: 16 },
      ],
    };
  };
  const buildArrow = (_api: FakeApi, from: string, to: string, label: string) => [{ id: `e${++n}`, type: 'arrow', x: 160, y: 32, width: 40, height: 0, version: 1, points: [[0, 0], [40, 0]], startBinding: { elementId: from }, endBinding: { elementId: to }, customData: { label } }];
  const buildNote = (_api: FakeApi, text: string) => [{ id: `n${++n}`, type: 'text', x: 0, y: 100, width: 200, height: 20, version: 1, text, originalText: text, fontSize: 14 }];
  return { default: FakeCanvas, restore: (e: unknown) => e, findBox, addBox: () => 'x', addArrow: () => 'y', renameBox: () => {}, removeElement: () => {}, toPng: async () => new Blob(), penHost, buildBox, buildArrow, buildNote, elementsOf: () => [], idsBy: () => [], ownedBy: () => true };
});

import InterviewBoard, { type BoardHandle } from './InterviewBoard';
import { createRef } from 'react';

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
};

describe('InterviewBoard with a canvas that reports a change after every render', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    changes.count = 0;
    changes.throwOnRender = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: { board: { version: 1, fingerprint: 'none', elements: [] } } }), { status: 200 })));
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: vi.fn(() => true) });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('settles after a change instead of re-rendering the canvas forever', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => root.render(<InterviewBoard sessionId="s1" disabled={false} onError={() => {}} />));
    await flush();
    expect(host.querySelector('[data-testid="canvas"]')).not.toBeNull();
    expect(host.textContent).toContain('Unsaved changes');
    expect(changes.count).toBeLessThan(6);
    expect(errors.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining('Maximum update depth'));
    errors.mockRestore();
  });

  it('draws the model’s operations with the pen, in order, an arrow finding the box drawn before it (coach-mode.md, phase 5)', async () => {
    // A hidden tab: the pen lands its marks without the animation, so the test need not wait on it.
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try {
      const ref = createRef<BoardHandle>();
      await act(async () => root.render(<InterviewBoard ref={ref} sessionId="s1" disabled={false} onError={() => {}} author="coach" />));
      await flush();
      ref.current!.draw([
        { op: 'box', label: 'Gateway' },
        { op: 'box', label: 'Store', kind: 'oval' },
        { op: 'arrow', from: 'Gateway', to: 'Store', label: 'reads' },
        { op: 'note', text: 'Sessions live here', near: 'Store' },
        { op: 'box', label: 'gateway' }, // already on the board: nothing
      ]);
      await flush();
      await ref.current!.flush();
      const els = scene.api!.getSceneElements() as { type: string; text?: string; startBinding?: { elementId: string }; endBinding?: { elementId: string }; containerId?: string }[];
      expect(els.filter((e) => e.type === 'rectangle').length).toBe(3); // the scene's own box and two drawn
      const labels = els.filter((e) => e.type === 'text' && e.containerId).map((e) => e.text);
      expect(labels).toEqual(['Gateway', 'Store']);
      const arrow = els.find((e) => e.type === 'arrow')!;
      const gateway = els.find((e) => e.text === 'Gateway')!.containerId;
      const store = els.find((e) => e.text === 'Store')!.containerId;
      expect(arrow.startBinding?.elementId).toBe(gateway);
      expect(arrow.endBinding?.elementId).toBe(store);
      expect(els.some((e) => e.type === 'text' && e.text === 'Sessions live here')).toBe(true);
      // The pen rested: no cursor left over the canvas.
      expect(host.querySelector('.ivr-board__pen')).toBeNull();
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    }
  });

  it('keeps the room when the canvas crashes, and mounts it again on request', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    changes.throwOnRender = true;
    await act(async () => root.render(<InterviewBoard sessionId="s1" disabled={false} onError={() => {}} />));
    await flush();
    expect(host.textContent).toContain('The canvas hit an error');
    expect(host.querySelector('[data-testid="canvas"]')).toBeNull();
    changes.throwOnRender = false;
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reload the canvas');
    expect(button).toBeDefined();
    await act(async () => button!.click());
    await flush();
    expect(host.querySelector('[data-testid="canvas"]')).not.toBeNull();
    errors.mockRestore();
  });
});
