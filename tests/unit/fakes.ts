import type { CDPSession, Page, TestInfo } from '@playwright/test';

type Handler = (params?: Record<string, unknown>) => unknown;

/**
 * Stands in for a CDP session. Each method answers from `handlers`, or with an
 * empty object, and every call is recorded in `sent`.
 */
export class FakeCdp {
  handlers: Record<string, Handler> = {};
  sent: string[] = [];
  detachError: unknown = null;
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push(method);
    const handler = this.handlers[method];
    return handler ? await handler(params) : {};
  }

  on(event: string, listener: (payload: unknown) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener: (payload: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  async detach(): Promise<void> {
    if (this.detachError) throw this.detachError;
  }

  /** Answers `takeHeapSnapshot` with this text, streamed in two chunks the way Chrome sends it. */
  streams(json: string): this {
    this.handlers['HeapProfiler.takeHeapSnapshot'] = () => {
      const half = Math.floor(json.length / 2);
      this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: json.slice(0, half) });
      this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: json.slice(half) });
      return {};
    };
    return this;
  }

  /** Answers `Performance.getMetrics` with these counts. */
  metrics(read: () => Record<string, number>): this {
    this.handlers['Performance.getMetrics'] = () => ({
      metrics: Object.entries(read()).map(([name, value]) => ({ name, value })),
    });
    return this;
  }

  asSession(): CDPSession {
    return this as unknown as CDPSession;
  }
}

export interface FakePage {
  page: Page;
  cdp: FakeCdp;
  sessionsOpened: () => number;
  clockCalls: string[];
}

/** A page with just enough of Playwright's API for the soak runner, the clock and CDP. */
export function fakePage({
  evaluate = async () => true,
  cdp = new FakeCdp(),
}: { evaluate?: (fn: unknown) => Promise<unknown>; cdp?: FakeCdp } = {}): FakePage {
  let opened = 0;
  const clockCalls: string[] = [];
  const page = {
    context: () => ({
      newCDPSession: async () => {
        opened++;
        return cdp;
      },
    }),
    evaluate,
    clock: {
      install: async () => void clockCalls.push('install'),
      pauseAt: async () => void clockCalls.push('pauseAt'),
      runFor: async (ms: number) => void clockCalls.push(`runFor ${ms}`),
    },
    waitForResponse: async () => {
      throw new Error('timed out');
    },
  };
  return { page: page as unknown as Page, cdp, sessionsOpened: () => opened, clockCalls };
}

export interface FakeTestInfo {
  testInfo: TestInfo;
  attached: Array<{ name: string; path?: string; body?: unknown }>;
}

/** Enough of `TestInfo` for the runner: an output folder, attachments, a title and a timeout. */
export function fakeTestInfo(
  dir: string,
  { attach, timeout = 0, title = 'a fake test' }: {
    attach?: (name: string, options: { path?: string; body?: unknown }) => Promise<void>;
    timeout?: number;
    title?: string;
  } = {},
): FakeTestInfo {
  const attached: FakeTestInfo['attached'] = [];
  const testInfo = {
    title,
    timeout,
    outputPath: () => dir,
    attach: attach ?? (async (name: string, options: { path?: string; body?: unknown }) => {
      attached.push({ name, ...options });
    }),
  };
  return { testInfo: testInfo as unknown as TestInfo, attached };
}
