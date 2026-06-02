import {
  BuildBudget,
  type RouteMetrics,
} from '../index';
import { analyzeWebpackStats, chunkNameToRoute, isThirdParty, getTopModules } from '../analyzer';
import { generateReport, generateSummary } from '../reporter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(overrides: Partial<RouteMetrics> & { route: string }): RouteMetrics {
  return {
    buildTimeMs: 1000,
    bundleSizeBytes: 50 * 1024,
    memoryPeakBytes: 100 * 1024 * 1024,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BuildBudget — recording & finalizing
// ---------------------------------------------------------------------------

describe('BuildBudget', () => {
  it('records routes and finalizes a build', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/home' }));
    budget.recordRoute(makeRoute({ route: '/about' }));

    const report = budget.finalizeBuild();
    expect(report.totalRoutes).toBe(2);
    expect(report.routeMetrics).toHaveLength(2);
    expect(report.totalBuildTimeMs).toBe(2000);
  });

  it('tracks history across multiple builds', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/a' }));
    budget.finalizeBuild();

    budget.recordRoute(makeRoute({ route: '/a', bundleSizeBytes: 60 * 1024 }));
    budget.finalizeBuild();

    expect(budget.getHistory().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bloat detection
// ---------------------------------------------------------------------------

describe('bloat detection', () => {
  it('detects routes that grew > 20%', () => {
    const budget = new BuildBudget({ bloatThreshold: 0.20 });

    budget.recordRoute(makeRoute({
      route: '/dashboard',
      bundleSizeBytes: 42 * 1024,
      modules: [{ name: './Dashboard.tsx', sizeBytes: 42 * 1024 }],
    }));
    budget.finalizeBuild();

    budget.recordRoute(makeRoute({
      route: '/dashboard',
      bundleSizeBytes: 78 * 1024,
      modules: [
        { name: './Dashboard.tsx', sizeBytes: 15 * 1024 },
        { name: 'd3-full', sizeBytes: 45 * 1024 },
        { name: 'moment', sizeBytes: 18 * 1024 },
      ],
    }));
    const report = budget.finalizeBuild();

    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0].route).toBe('/dashboard');
    expect(report.alerts[0].growthPercent).toBeCloseTo(0.857, 1);
    expect(report.alerts[0].addedDependencies).toContain('d3-full');
    expect(report.alerts[0].addedDependencies).toContain('moment');
    expect(report.alerts[0].severity).toBe('critical');
  });

  it('does not alert for routes under threshold', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/x', bundleSizeBytes: 100 }));
    budget.finalizeBuild();

    budget.recordRoute(makeRoute({ route: '/x', bundleSizeBytes: 115 }));
    const report = budget.finalizeBuild();

    expect(report.alerts).toHaveLength(0);
  });

  it('returns empty alerts on first build (no history)', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/a' }));
    const report = budget.finalizeBuild();
    expect(report.alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe('budget enforcement', () => {
  it('violates when route exceeds bundle size budget', () => {
    const budget = new BuildBudget();
    budget.addBudget({ route: '/heavy', maxBundleSizeBytes: 10 * 1024 });
    budget.recordRoute(makeRoute({ route: '/heavy', bundleSizeBytes: 50 * 1024 }));

    const report = budget.finalizeBuild();
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].reason).toContain('exceeds budget');
  });

  it('violates on build time budget', () => {
    const budget = new BuildBudget();
    budget.addBudget({ route: '/slow', maxBundleSizeBytes: Infinity, maxBuildTimeMs: 500 });
    budget.recordRoute(makeRoute({ route: '/slow', buildTimeMs: 2000 }));

    const report = budget.finalizeBuild();
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].reason).toContain('Build time');
  });

  it('violates on memory budget', () => {
    const budget = new BuildBudget();
    budget.addBudget({
      route: '/memoryhog',
      maxBundleSizeBytes: Infinity,
      maxMemoryBytes: 50 * 1024 * 1024,
    });
    budget.recordRoute(makeRoute({ route: '/memoryhog', memoryPeakBytes: 200 * 1024 * 1024 }));

    const report = budget.finalizeBuild();
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].reason).toContain('Memory');
  });

  it('supports glob patterns for route matching', () => {
    const budget = new BuildBudget();
    budget.addBudget({ route: '/admin/*', maxBundleSizeBytes: 10 * 1024 });
    budget.recordRoute(makeRoute({ route: '/admin/settings', bundleSizeBytes: 50 * 1024 }));

    const report = budget.finalizeBuild();
    expect(report.violations).toHaveLength(1);
  });

  it('no violations when within budget', () => {
    const budget = new BuildBudget();
    budget.addBudget({ route: '/fine', maxBundleSizeBytes: 100 * 1024 });
    budget.recordRoute(makeRoute({ route: '/fine', bundleSizeBytes: 50 * 1024 }));

    const report = budget.finalizeBuild();
    expect(report.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conservation scores
// ---------------------------------------------------------------------------

describe('conservation scores', () => {
  it('ranks routes by composite score', () => {
    const budget = new BuildBudget();
    budget.setFrequencyEstimates(new Map([
      ['/popular', 10000],
      ['/obscure', 10],
    ]));

    budget.recordRoute(makeRoute({
      route: '/popular',
      bundleSizeBytes: 100 * 1024,
      modules: [{ name: 'a', sizeBytes: 50 * 1024 }, { name: 'b', sizeBytes: 50 * 1024 }],
    }));
    budget.recordRoute(makeRoute({
      route: '/obscure',
      bundleSizeBytes: 200 * 1024,
      modules: [{ name: 'c', sizeBytes: 200 * 1024 }],
    }));

    const report = budget.finalizeBuild();
    expect(report.scores[0].route).toBe('/popular');
  });

  it('returns empty scores when no routes recorded', () => {
    const budget = new BuildBudget();
    const report = budget.finalizeBuild();
    expect(report.scores).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// compareRoute
// ---------------------------------------------------------------------------

describe('compareRoute', () => {
  it('generates human-readable comparison text', () => {
    const budget = new BuildBudget();

    budget.recordRoute(makeRoute({
      route: '/dashboard',
      bundleSizeBytes: 42 * 1024,
      modules: [{ name: './Dashboard.tsx', sizeBytes: 42 * 1024 }],
    }));
    budget.finalizeBuild();

    budget.recordRoute(makeRoute({
      route: '/dashboard',
      bundleSizeBytes: 78 * 1024,
      modules: [
        { name: './Dashboard.tsx', sizeBytes: 15 * 1024 },
        { name: 'd3-full', sizeBytes: 45 * 1024 },
        { name: 'moment', sizeBytes: 18 * 1024 },
      ],
    }));

    const comparison = budget.compareRoute('/dashboard');
    expect(comparison).toContain('grew from');
    expect(comparison).toContain('+86%');
    expect(comparison).toContain('d3-full');
    expect(comparison).toContain('moment');
  });

  it('returns null on first build', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/x' }));
    expect(budget.compareRoute('/x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

describe('analyzeWebpackStats', () => {
  it('extracts chunk analyses from stats', () => {
    const stats = {
      chunks: [
        { id: 0, names: ['pages/dashboard'], size: 78000 },
        { id: 1, names: ['pages/index'], size: 15000 },
      ],
      modules: [
        { name: './Dashboard.tsx', size: 15000, chunks: [0] },
        { name: 'node_modules/d3-full/index.js', size: 45000, chunks: [0] },
        { name: './Home.tsx', size: 15000, chunks: [1] },
      ],
      assets: [
        { name: 'static/dashboard.js', chunks: [0], size: 78000 },
        { name: 'static/index.js', chunks: [1], size: 15000 },
      ],
    };

    const analyses = analyzeWebpackStats(stats);
    expect(analyses).toHaveLength(2);

    const dashboard = analyses.find((a) => a.name === 'pages/dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard!.modules).toHaveLength(2);
    expect(dashboard!.assetFile).toBe('static/dashboard.js');
  });

  it('handles concatenated modules', () => {
    const stats = {
      chunks: [{ id: 0, names: ['pages/test'], size: 5000 }],
      modules: [{
        name: './concatenated',
        size: 5000,
        chunks: [0],
        modules: [
          { name: './a.tsx', size: 3000 },
          { name: './b.tsx', size: 2000 },
        ],
      }],
    };

    const analyses = analyzeWebpackStats(stats);
    expect(analyses[0].modules).toHaveLength(2);
  });
});

describe('chunkNameToRoute', () => {
  it('converts pages/ paths to routes', () => {
    expect(chunkNameToRoute('pages/dashboard.js')).toBe('/dashboard');
    expect(chunkNameToRoute('pages/index.js')).toBe('/');
    expect(chunkNameToRoute('pages/api/users.js')).toBe('/api/users');
    expect(chunkNameToRoute('src/pages/settings/index.tsx')).toBe('/settings');
  });
});

describe('isThirdParty', () => {
  it('identifies third-party modules', () => {
    expect(isThirdParty('node_modules/lodash/index.js')).toBe(true);
    expect(isThirdParty('react')).toBe(true);
    expect(isThirdParty('./components/Button.tsx')).toBe(false);
    expect(isThirdParty('/app/utils.ts')).toBe(false);
  });
});

describe('getTopModules', () => {
  it('returns largest modules across all chunks', () => {
    const analyses = [
      { name: 'a', totalSizeBytes: 100, modules: [{ name: 'x', sizeBytes: 50 }, { name: 'y', sizeBytes: 50 }] },
      { name: 'b', totalSizeBytes: 200, modules: [{ name: 'x', sizeBytes: 100 }, { name: 'z', sizeBytes: 100 }] },
    ];

    const top = getTopModules(analyses, 2);
    expect(top).toHaveLength(2);
    expect(top[0].name).toBe('x');
    expect(top[0].sizeBytes).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  it('produces valid markdown', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/home', buildTimeMs: 800, bundleSizeBytes: 15 * 1024 }));
    budget.recordRoute(makeRoute({ route: '/dashboard', buildTimeMs: 3200, bundleSizeBytes: 78 * 1024 }));
    budget.recordRoute(makeRoute({ route: '/settings', buildTimeMs: 1100, bundleSizeBytes: 22 * 1024 }));

    const report = budget.finalizeBuild();
    const md = generateReport(report);

    expect(md).toContain('# Build Budget Report');
    expect(md).toContain('/home');
    expect(md).toContain('/dashboard');
    expect(md).toContain('Per-Route Breakdown');
  });
});

describe('generateSummary', () => {
  it('produces a one-paragraph executive summary', () => {
    const budget = new BuildBudget();
    budget.recordRoute(makeRoute({ route: '/home', buildTimeMs: 800, bundleSizeBytes: 15 * 1024 }));
    budget.recordRoute(makeRoute({ route: '/dashboard', buildTimeMs: 3200, bundleSizeBytes: 78 * 1024 }));
    budget.recordRoute(makeRoute({ route: '/settings', buildTimeMs: 1100, bundleSizeBytes: 22 * 1024 }));

    const report = budget.finalizeBuild();
    const summary = generateSummary(report);

    expect(summary).toContain('Your build takes');
    expect(summary).toContain('3 routes account for');
    expect(summary).toContain('largest');
  });

  it('mentions bloat in summary', () => {
    const budget = new BuildBudget();

    budget.recordRoute(makeRoute({ route: '/x', bundleSizeBytes: 40 * 1024, modules: [{ name: 'a', sizeBytes: 40 * 1024 }] }));
    budget.finalizeBuild();

    budget.recordRoute(makeRoute({ route: '/x', bundleSizeBytes: 80 * 1024, modules: [{ name: 'a', sizeBytes: 40 * 1024 }, { name: 'b', sizeBytes: 40 * 1024 }] }));
    const report = budget.finalizeBuild();

    const summary = generateSummary(report);
    expect(summary).toContain('grew');
  });

  it('mentions violations in summary', () => {
    const budget = new BuildBudget();
    budget.addBudget({ route: '/big', maxBundleSizeBytes: 10 });
    budget.recordRoute(makeRoute({ route: '/big', bundleSizeBytes: 9999 }));

    const report = budget.finalizeBuild();
    const summary = generateSummary(report);
    expect(summary).toContain('exceed their budget');
  });
});
