/**
 * @superinstance/guardian — Build Budget Guardian
 *
 * Tracks per-route build resource usage and enforces conservation
 * principles so your Next.js build stays lean over time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteMetrics {
  /** Route path, e.g. "/dashboard" */
  route: string;
  /** Wall-clock build time in milliseconds */
  buildTimeMs: number;
  /** Final client bundle size in bytes */
  bundleSizeBytes: number;
  /** Peak RSS during this route's compilation */
  memoryPeakBytes: number;
  /** Per-module breakdown (optional, populated by analyzer) */
  modules?: ModuleEntry[];
  /** First-party vs third-party size split */
  firstPartyBytes?: number;
  thirdPartyBytes?: number;
  /** Timestamp of this measurement */
  timestamp: number;
}

export interface ModuleEntry {
  /** Module identifier / path */
  name: string;
  /** Size in bytes as included in the bundle */
  sizeBytes: number;
}

export interface RouteBudget {
  /** Route glob or exact path */
  route: string;
  /** Maximum allowed client bundle size in bytes */
  maxBundleSizeBytes: number;
  /** Maximum allowed build time in ms (0 = no limit) */
  maxBuildTimeMs?: number;
  /** Maximum allowed peak memory in bytes (0 = no limit) */
  maxMemoryBytes?: number;
}

export interface ConservationScore {
  route: string;
  /** Composite score: size × frequency × complexity */
  score: number;
  /** Normalized bundle size (0-1 relative to largest route) */
  sizeNormalized: number;
  /** Estimated page-view frequency (requests / day) */
  frequency: number;
  /** Number of distinct modules / dependencies */
  complexity: number;
}

export interface BloatAlert {
  route: string;
  previousSizeBytes: number;
  currentSizeBytes: number;
  /** Percentage growth (e.g. 0.85 = +85%) */
  growthPercent: number;
  /** Modules that appeared for the first time */
  addedDependencies: string[];
  severity: 'warning' | 'critical';
}

export interface BudgetViolation {
  route: string;
  budget: RouteBudget;
  actual: Pick<RouteMetrics, 'bundleSizeBytes' | 'buildTimeMs' | 'memoryPeakBytes'>;
  reason: string;
}

export interface BuildReport {
  generatedAt: number;
  totalRoutes: number;
  totalBuildTimeMs: number;
  totalBundleSizeBytes: number;
  alerts: BloatAlert[];
  violations: BudgetViolation[];
  scores: ConservationScore[];
  routeMetrics: RouteMetrics[];
}

export interface HistoryEntry {
  timestamp: number;
  metrics: RouteMetrics[];
}

// ---------------------------------------------------------------------------
// BuildBudget class
// ---------------------------------------------------------------------------

export class BuildBudget {
  private currentMetrics: Map<string, RouteMetrics> = new Map();
  private history: HistoryEntry[] = [];
  private budgets: RouteBudget[] = [];
  private frequencyEstimates: Map<string, number> = new Map();

  /** Bloat threshold — routes that grew more than this trigger alerts */
  public bloatThreshold: number = 0.20; // 20 %

  constructor(opts?: { bloatThreshold?: number }) {
    if (opts?.bloatThreshold !== undefined) {
      this.bloatThreshold = opts.bloatThreshold;
    }
  }

  // ----- Recording ----------------------------------------------------------

  /**
   * Record metrics for a single route. Call once per route after compilation.
   */
  recordRoute(metrics: RouteMetrics): void {
    this.currentMetrics.set(metrics.route, {
      ...metrics,
      timestamp: metrics.timestamp || Date.now(),
    });
  }

  /**
   * Finalize the current build snapshot — runs detection & enforcement, then
   * pushes the snapshot into history.
   */
  finalizeBuild(): BuildReport {
    const metrics = Array.from(this.currentMetrics.values());
    const snapshot: HistoryEntry = { timestamp: Date.now(), metrics };
    this.history.push(snapshot);

    const alerts = this.detectBloat();
    const violations = this.enforceBudgets();
    const scores = this.computeConservationScores();

    const report: BuildReport = {
      generatedAt: snapshot.timestamp,
      totalRoutes: metrics.length,
      totalBuildTimeMs: metrics.reduce((s, m) => s + m.buildTimeMs, 0),
      totalBundleSizeBytes: metrics.reduce((s, m) => s + m.bundleSizeBytes, 0),
      alerts,
      violations,
      scores,
      routeMetrics: metrics,
    };

    return report;
  }

  // ----- Budget management --------------------------------------------------

  /** Set route budgets. Replaces any previously set budgets. */
  setBudgets(budgets: RouteBudget[]): void {
    this.budgets = budgets;
  }

  /** Add a single route budget. */
  addBudget(budget: RouteBudget): void {
    this.budgets.push(budget);
  }

  // ----- Frequency estimates ------------------------------------------------

  /** Provide estimated page-view frequencies (requests/day) for routes. */
  setFrequencyEstimates(estimates: Map<string, number>): void {
    this.frequencyEstimates = estimates;
  }

  // ----- Bloat detection ----------------------------------------------------

  /**
   * Compare current metrics to the previous build snapshot.
   * Returns alerts for routes that grew beyond the bloat threshold.
   */
  detectBloat(): BloatAlert[] {
    const alerts: BloatAlert[] = [];
    if (this.history.length < 2) return alerts;

    const previous = this.history[this.history.length - 2];
    const prevMap = new Map(previous.metrics.map((m) => [m.route, m]));

    for (const current of this.currentMetrics.values()) {
      const prev = prevMap.get(current.route);
      if (!prev || prev.bundleSizeBytes === 0) continue;

      const growth = (current.bundleSizeBytes - prev.bundleSizeBytes) / prev.bundleSizeBytes;
      if (growth <= this.bloatThreshold) continue;

      const prevModuleNames = new Set((prev.modules ?? []).map((m) => m.name));
      const addedDeps = (current.modules ?? [])
        .filter((m) => !prevModuleNames.has(m.name))
        .map((m) => m.name);

      alerts.push({
        route: current.route,
        previousSizeBytes: prev.bundleSizeBytes,
        currentSizeBytes: current.bundleSizeBytes,
        growthPercent: growth,
        addedDependencies: addedDeps,
        severity: growth > 0.5 ? 'critical' : 'warning',
      });
    }

    return alerts;
  }

  // ----- Budget enforcement -------------------------------------------------

  /**
   * Check current metrics against defined budgets.
   * Returns violations — callers can choose to throw / fail the build.
   */
  enforceBudgets(): BudgetViolation[] {
    const violations: BudgetViolation[] = [];

    for (const budget of this.budgets) {
      const metric = this.findMatchingMetric(budget.route);
      if (!metric) continue;

      if (metric.bundleSizeBytes > budget.maxBundleSizeBytes) {
        violations.push({
          route: metric.route,
          budget,
          actual: {
            bundleSizeBytes: metric.bundleSizeBytes,
            buildTimeMs: metric.buildTimeMs,
            memoryPeakBytes: metric.memoryPeakBytes,
          },
          reason: `Bundle size ${formatBytes(metric.bundleSizeBytes)} exceeds budget of ${formatBytes(budget.maxBundleSizeBytes)}`,
        });
      }

      if (budget.maxBuildTimeMs && budget.maxBuildTimeMs > 0 && metric.buildTimeMs > budget.maxBuildTimeMs) {
        violations.push({
          route: metric.route,
          budget,
          actual: {
            bundleSizeBytes: metric.bundleSizeBytes,
            buildTimeMs: metric.buildTimeMs,
            memoryPeakBytes: metric.memoryPeakBytes,
          },
          reason: `Build time ${metric.buildTimeMs}ms exceeds budget of ${budget.maxBuildTimeMs}ms`,
        });
      }

      if (budget.maxMemoryBytes && budget.maxMemoryBytes > 0 && metric.memoryPeakBytes > budget.maxMemoryBytes) {
        violations.push({
          route: metric.route,
          budget,
          actual: {
            bundleSizeBytes: metric.bundleSizeBytes,
            buildTimeMs: metric.buildTimeMs,
            memoryPeakBytes: metric.memoryPeakBytes,
          },
          reason: `Memory peak ${formatBytes(metric.memoryPeakBytes)} exceeds budget of ${formatBytes(budget.maxMemoryBytes)}`,
        });
      }
    }

    return violations;
  }

  // ----- Conservation scores -----------------------------------------------

  /**
   * Compute a conservation score per route:
   *   score = sizeNormalized × frequency × complexity
   *
   * Higher scores mean the route is a bigger target for optimization.
   */
  computeConservationScores(): ConservationScore[] {
    const metrics = Array.from(this.currentMetrics.values());
    if (metrics.length === 0) return [];

    const maxSize = Math.max(...metrics.map((m) => m.bundleSizeBytes), 1);

    return metrics
      .map((m) => {
        const sizeNormalized = m.bundleSizeBytes / maxSize;
        const frequency = this.frequencyEstimates.get(m.route) ?? 100;
        const complexity = m.modules?.length ?? 1;
        return {
          route: m.route,
          score: sizeNormalized * frequency * complexity,
          sizeNormalized,
          frequency,
          complexity,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ----- Historical comparison text ----------------------------------------

  /**
   * Generate a human-readable comparison for a specific route.
   *
   * Example: "Route /dashboard grew from 42KB to 78KB (+85%). Added dependencies: d3-full, moment."
   */
  compareRoute(route: string): string | null {
    if (this.history.length < 1) return null;

    const prev = this.history[this.history.length - 1].metrics.find((m) => m.route === route);
    const curr = this.currentMetrics.get(route);
    if (!prev || !curr) return null;

    const growth = prev.bundleSizeBytes > 0
      ? ((curr.bundleSizeBytes - prev.bundleSizeBytes) / prev.bundleSizeBytes) * 100
      : 0;

    const prevModuleNames = new Set((prev.modules ?? []).map((m) => m.name));
    const addedDeps = (curr.modules ?? [])
      .filter((m) => !prevModuleNames.has(m.name))
      .map((m) => m.name);

    const direction = growth >= 0 ? 'grew' : 'shrank';
    const parts = [
      `Route ${route} ${direction} from ${formatBytes(prev.bundleSizeBytes)} to ${formatBytes(curr.bundleSizeBytes)} (${growth >= 0 ? '+' : ''}${growth.toFixed(0)}%).`,
    ];

    if (addedDeps.length > 0) {
      parts.push(`Added dependencies: ${addedDeps.join(', ')}.`);
    }

    return parts.join(' ');
  }

  // ----- Helpers ------------------------------------------------------------

  private findMatchingMetric(routePattern: string): RouteMetrics | undefined {
    const exact = this.currentMetrics.get(routePattern);
    if (exact) return exact;

    const regex = globToRegex(routePattern);
    for (const [route, metric] of this.currentMetrics) {
      if (regex.test(route)) return metric;
    }
    return undefined;
  }

  /** Get current metrics for a route. */
  getRouteMetrics(route: string): RouteMetrics | undefined {
    return this.currentMetrics.get(route);
  }

  /** Get build history. */
  getHistory(): ReadonlyArray<HistoryEntry> {
    return this.history;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
