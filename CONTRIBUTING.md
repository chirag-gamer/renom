# Contributing

## Ground rules

1. Work on feature branches; `dev` is the integration branch; tagged commits on `main` are releases.
2. Never commit secrets, `.env`, database files, backups or server data (enforced by `.gitignore` +
   gitleaks in CI).
3. Every behavior change ships with tests. Security-sensitive utilities (path confinement, authz)
   require property/negative tests and a SEC review label in the PR.
4. Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
5. Update `CHANGELOG.md` in the same change as user-visible behavior.

## Definition of done

Code + tests + types clean + lint clean + SPEC requirement ID referenced in the PR description +
changelog entry when behavior changes. See `README.md` for commands.

## Local checks before pushing

```bash
npm run typecheck && npm run lint && npm test
```
