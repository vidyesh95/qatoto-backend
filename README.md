# Qatoto Backend

[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/vidyesh95/qatoto-backend?utm_source=badge)

Qatoto is a platform for product research, development and support.

## Getting Started

### Prerequisites

- Node.js >= 24.13.1
- pnpm >= 10.29.3

### Installation

```bash
pnpm install
```

### Running the Server

```bash
pnpm run dev
```

### Running Tests

```bash
pnpm test
```

### Running Benchmarks

```bash
pnpm bench
```

The suites live next to the code they measure, as `src/**/*.bench.ts`, and are
run by `scripts/run-benchmarks.ts`. Every pull request runs them again under
CodSpeed's CPU simulation instrument, which reports the change against the
target branch.

### Formatting

```bash
pnpm run fmt
```

### Linting

```bash
pnpm run lint
```
