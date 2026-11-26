## Why

<!-- The problem this solves or the outcome it enables. Link the issue if there is one. -->

## What changed

<!-- The approach, and anything a reviewer should look at first. -->

## How it was tested

<!-- Commands run, tests added, manual checks. -->

## Checklist

- [ ] The PR title follows Conventional Commits (`feat: ...`, `fix(api): ...`).
- [ ] Every commit message follows Conventional Commits; each commit is one logical change.
- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm knip` pass locally.
- [ ] New code has tests; coverage thresholds were not lowered.
- [ ] Docs (README, docs/ARCHITECTURE.md, an ADR) are updated if behaviour or a decision changed.
- [ ] No secrets, personal data or local machine details in code, fixtures, commits or this description.
