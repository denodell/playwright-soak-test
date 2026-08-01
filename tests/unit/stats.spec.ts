import { expect, test } from '@playwright/test';
import { classifyShape, linearFit, percentGrowth, sparkline, trendOf } from '../../src/stats.js';
import { mergeSoakOptions, resolveSoakOptions } from '../../src/soak.js';
import { describeMetrics } from '../../src/diagnose.js';
import type { SoakResult, SoakSample } from '../../src/types.js';

function samples(values: number[]): SoakSample[] {
  return values.map((nodes, i) => ({ pass: i, nodes, heap: 0, listeners: 0, documents: 1 }));
}

test.describe('linearFit', () => {
  test('recovers the slope of a straight line', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 100 + i * 40 }));
    const { slope, r2 } = linearFit(points);
    expect(slope).toBeCloseTo(40, 6);
    expect(r2).toBeCloseTo(1, 6);
  });

  test('calls a flat series a perfect fit with a slope of zero', () => {
    const { slope, r2 } = linearFit(Array.from({ length: 8 }, (_, i) => ({ x: i, y: 43 })));
    expect(slope).toBe(0);
    expect(r2).toBe(1);
  });

  test('reports a poor fit for a scattered series', () => {
    const noisy = [3, -2, 5, -4, 1, 6, -3, 2].map((y, x) => ({ x, y }));
    expect(linearFit(noisy).r2).toBeLessThan(0.5);
  });

  test('needs two points to say anything', () => {
    expect(linearFit([{ x: 0, y: 5 }])).toEqual({ slope: 0, r2: 1 });
  });
});

test.describe('classifyShape', () => {
  test('calls steady growth linear', () => {
    const s = samples([0, 40, 80, 120, 160, 200, 240]);
    const { slope, r2 } = linearFit(s.map((x) => ({ x: x.pass, y: x.nodes })));
    expect(classifyShape(s, 'nodes', slope, r2, 240).shape).toBe('linear');
  });

  test('calls a single jump a step, and says which pass it landed on', () => {
    const s = samples([0, 0, 150, 150, 150, 150, 150]);
    const { slope, r2 } = linearFit(s.map((x) => ({ x: x.pass, y: x.nodes })));
    const shape = classifyShape(s, 'nodes', slope, r2, 150);
    expect(shape.shape).toBe('step');
    expect(shape.stepAtPass).toBe(2);
  });

  test('calls an early climb settled, even though it fits a line badly', () => {
    const curve = Array.from({ length: 12 }, (_, i) => Math.round(1000 * (1 - Math.exp(-i / 1.5))));
    const s = samples(curve);
    const { slope, r2 } = linearFit(s.map((x) => ({ x: x.pass, y: x.nodes })));
    expect(classifyShape(s, 'nodes', slope, r2, curve[11]! - curve[0]!).shape).toBe('settled');
    expect(r2).toBeLessThan(0.9);
  });

  test('keeps steady growth linear rather than settled', () => {
    const curve = Array.from({ length: 12 }, (_, i) => i * 40);
    const s = samples(curve);
    const { slope, r2 } = linearFit(s.map((x) => ({ x: x.pass, y: x.nodes })));
    expect(classifyShape(s, 'nodes', slope, r2, curve[11]!).shape).toBe('linear');
  });

  test('calls no growth flat', () => {
    const s = samples([43, 43, 43, 43, 43]);
    expect(classifyShape(s, 'nodes', 0, 1, 0).shape).toBe('flat');
  });

  test('calls jitter noisy', () => {
    const s = samples([43, 44, 43, 42, 44, 43, 44, 42]);
    const { slope, r2 } = linearFit(s.map((x) => ({ x: x.pass, y: x.nodes })));
    expect(classifyShape(s, 'nodes', slope, r2, -1).shape).toBe('noisy');
  });
});

test.describe('trendOf', () => {
  test('reports growth per pass alongside the total', () => {
    const s = samples([200, 240, 280, 320, 360]);
    const trend = trendOf(s, 'nodes', 200, 360);
    expect(trend.perPass).toBeCloseTo(40, 6);
    expect(trend.total).toBe(160);
    expect(trend.shape).toBe('linear');
  });
});

test.describe('percentGrowth', () => {
  test('measures against the baseline', () => {
    expect(percentGrowth(100, 110)).toBeCloseTo(10, 6);
  });

  test('returns zero when the baseline is zero', () => {
    expect(percentGrowth(0, 500)).toBe(0);
  });
});

test.describe('sparkline', () => {
  test('climbs with the readings', () => {
    const line = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(line).toBe('▁▂▃▄▅▆▇█');
  });

  test('draws a flat series flat', () => {
    expect(sparkline([43, 43, 43, 43])).toBe('▁▁▁▁');
  });

  test('draws a wobble flat rather than filling the height', () => {
    expect(sparkline([43, 44, 43, 42, 44, 43], { floor: 3 })).toBe('▁▁▁▁▁▁');
    expect(sparkline([43, 44, 43, 42, 47, 43], { floor: 3 })).not.toBe('▁▁▁▁▁▁');
  });

  test('buckets a long run down to the width', () => {
    expect(sparkline(Array.from({ length: 500 }, (_, i) => i)).length).toBe(24);
    expect(sparkline(Array.from({ length: 500 }, (_, i) => i), { width: 10 }).length).toBe(10);
  });

  test('says nothing when there is nothing to draw', () => {
    expect(sparkline([])).toBe('');
  });
});

test.describe('the heap floor', () => {
  function heapResult(growthPercent: number): SoakResult {
    const base = 1_000_000;
    const readings = Array.from({ length: 12 }, (_, i) => ({
      pass: i,
      nodes: 36,
      listeners: 157,
      heap: base * (1 + (growthPercent / 100) * (i / 11)),
      documents: 1,
    }));
    const first = readings[0]!;
    const last = readings[11]!;
    return {
      label: 'run',
      passes: 100,
      warmup: 5,
      baseline: first,
      after: last,
      samples: readings,
      trends: {
        nodes: trendOf(readings, 'nodes', first.nodes, last.nodes),
        listeners: trendOf(readings, 'listeners', first.listeners, last.listeners),
        heap: trendOf(readings, 'heap', first.heap, last.heap),
      },
      failures: [],
      leaking: false,
      allowances: { nodes: 100, listeners: 0, heap: null },
      clock: { enabled: false, advanceMs: 0, virtualElapsedMs: null },
      exposeGc: true,
      responseTimeouts: 0,
    };
  }

  const heapLine = (growthPercent: number): string => describeMetrics(heapResult(growthPercent))[2]!;

  test('draws a clean build flat', () => {
    expect(heapLine(2)).toContain('▁▁▁▁▁▁▁▁▁▁▁▁');
    expect(heapLine(3.97)).toContain('▁▁▁▁▁▁▁▁▁▁▁▁');
  });

  test('draws once the growth clears the floor', () => {
    expect(heapLine(6.24)).toContain('█');
    expect(heapLine(10)).toContain('█');
  });
});

test.describe('resolveSoakOptions', () => {
  test('defaults to 200 passes with a 5-pass warmup', () => {
    const o = resolveSoakOptions();
    expect(o.passes).toBe(200);
    expect(o.warmup).toBe(5);
    expect(o.nodeAllowance).toBe(100);
    expect(o.listenerAllowance).toBe(0);
    expect(o.heapAllowancePercent).toBeNull();
    expect(o.gcPasses).toBe(2);
    expect(o.clock).toEqual({ advanceMs: 18_000 });
  });

  test('lets a run override the config defaults', () => {
    const o = resolveSoakOptions(mergeSoakOptions({ passes: 100 }, { passes: 20, nodeAllowance: 5 }));
    expect(o.passes).toBe(20);
    expect(o.nodeAllowance).toBe(5);
  });

  test('keeps the clock off when either level turns it off', () => {
    expect(mergeSoakOptions({ clock: false }, {}).clock).toBe(false);
    expect(mergeSoakOptions({}, { clock: false }).clock).toBe(false);
    expect(mergeSoakOptions({ clock: false }, { clock: { advanceMs: 100 } }).clock).toBe(false);
  });

  test('samples about 25 times across the measured window', () => {
    expect(resolveSoakOptions({ passes: 205, warmup: 5 }).sampleEvery).toBe(8);
  });

  test('refuses a run with nothing left to measure', () => {
    expect(() => resolveSoakOptions({ passes: 6, warmup: 5 })).toThrow(/at least 2 after the warmup/);
  });
});
