# @superinstance/guardian

Build Budget Guardian for Next.js — tracks build resource usage and enforces conservation principles.

Your build takes 47s. Three routes account for 62% of that time. `/dashboard` is the largest at 78KB — up 85% from last build.

## Why

Next.js builds grow silently. A route that was 15KB six months ago is now 120KB because someone imported moment.js and d3-full for a single chart. Nobody notices until deploy times crawl and users stare at loading spinners.

Guardian watches your builds so you can catch bloat before it ships.

## What It Does

- **Per-route tracking** — build time, bundle size, and memory peak for every route
- **Bloat detection** — flags routes that grew >20% since the last build (configurable)
- **Budget enforcement** — fail the build if a route exceeds its size/time/memory budget
- **Historical comparison** — "Route /dashboard grew from 42KB to 78KB (+85%). Added dependencies: d3-full, moment."
- **Conservation scores** — composite ranking (size × frequency × complexity) to prioritize optimization
- **Markdown reports** — human-readable build summaries for CI or local review

## Install

```bash
npm install @superinstance/guardian
```

## Quick Start

```typescript
import { BuildBudget } from '@superinstance/guardian';
import { analyzeWebpackStats } from '@superinstance/guardian/analyzer';
import { generateReport } from '@superinstance/guardian/reporter';

const budget = new BuildBudget({ bloatThreshold: 0.20 });

// Set budgets per route
budget.addBudget({ route: '/dashboard', maxBundleSizeBytes: 100 * 1024 });
budget.addBudget({ route: '/admin/*', maxBundleSizeBytes: 200 * 1024 });

// After each route builds, record metrics
budget.recordRoute({
  route: '/dashboard',
  buildTimeMs: 3200,
  bundleSizeBytes: 78 * 1024,
  memoryPeakBytes: 150 * 1024 * 1024,
  modules: [
    { name: 'd3-full', sizeBytes: 45 * 1024 },
    { name: 'moment', sizeBytes: 18 * 1024 },
    { name: './Dashboard.tsx', sizeBytes: 15 * 1024 },
  ],
  timestamp: Date.now(),
});

// Finalize the build
const report = budget.finalizeBuild();

// Generate markdown
console.log(generateReport(report));

// Check for violations
if (report.violations.length > 0) {
  console.error('Build budget exceeded!');
  process.exit(1);
}
```

## Conservation Score

Every route gets a conservation score:

```
score = normalizedSize × dailyFrequency × moduleComplexity
```

Higher score = bigger optimization target. Sort by score descending and start optimizing there.

## Report Example

```markdown
# Build Budget Report

Your build takes 47s. 3 routes account for 62% of that time. /dashboard is
the largest at 78KB. /dashboard grew 85% from last build — added: d3-full, moment.

## ⚠️ Bloat Alerts

🟡 **/dashboard**: 42KB → 78KB (+85%). Added: d3-full, moment

## Per-Route Breakdown

| Route        | Build Time | Bundle Size | Memory Peak |
|-------------|-----------|------------|-------------|
| /dashboard  | 3.2s      | 78KB       | 150MB       |
| /settings   | 1.1s      | 22KB       | 80MB        |
| /           | 0.8s      | 15KB       | 65MB        |
```

## Integration with Next.js

Use Guardian as a webpack plugin or in `next.config.js`:

```javascript
// next.config.js
const { BuildBudget } = require('@superinstance/guardian');

const budget = new BuildBudget();
budget.addBudget({ route: '/dashboard', maxBundleSizeBytes: 100 * 1024 });

module.exports = {
  webpack(config, { isServer }) {
    if (!isServer) {
      config.plugins.push({
        apply(compiler) {
          compiler.hooks.afterEmit.tap('Guardian', (compilation) => {
            const stats = compilation.getStats().toJson({
              assets: true, chunks: true, modules: true, chunkModules: true,
            });
            // Analyze and record...
          });
        },
      });
    }
    return config;
  },
};
```

## API

### `BuildBudget`

- `recordRoute(metrics)` — record per-route metrics
- `finalizeBuild()` — run analysis, return `BuildReport`
- `addBudget(budget)` / `setBudgets(budgets)` — define route budgets
- `detectBloat()` — get bloat alerts
- `enforceBudgets()` — get budget violations
- `computeConservationScores()` — ranked optimization targets
- `compareRoute(route)` — human-readable historical comparison

### `analyzeWebpackStats(statsJson)`

Extract per-chunk module breakdown from webpack stats.

### `generateReport(report)`

Generate a markdown build report.

## License

MIT
