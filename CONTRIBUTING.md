# Contributing to Qatoto Backend

Thank you for your interest in contributing! We want to make contributing to this project as easy and transparent as possible.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](https://github.com/vidyesh95/qatoto-backend/tree/main?tab=coc-ov-file).

## How Can I Contribute?

### Reporting Bugs

- Use the GitHub Issue Tracker.
- Describe the bug and include steps to reproduce.
- Note any relevant environment details (OS, Node version).

### Suggesting Enhancements

- Open a GitHub Issue with the "enhancement" label.
- Explain why this enhancement would be useful.

### Commit Messages

- Use Conventional Commits format.
- Use imperative mood.
- Use present tense.
- Use lowercase.

    Example:
- feat: Add user authentication
- fix: Resolve login bug
- docs: Update README

### Pull Requests

1. Fork the repo and create your branch from `main`.
2. Follow the [Code Style](#code-style) guidelines.
3. Ensure the test suite passes.
4. Provide a clear description of the change in your PR.

## Code Style

### Formatting with Oxc

To maintain a consistent codebase, we use `oxfmt` for formatting. **You must format your code before submitting a Pull Request.**

We have provided a script to make this easy:

```bash
pnpm run format
```

This will run `oxfmt` on the entire project and apply any necessary changes.

### Naming Conventions

- Use PascalCase for classes.
- Use camelCase for variables, functions, and file names (unless they correspond to a class).
- Use kebab-case for directory names.
