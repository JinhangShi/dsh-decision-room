# Development rules

- Use TypeScript with strict checking. Keep the Host state authoritative.
- Do not commit credentials, imported environment files, task records or generated private reports.
- Do not invent model prices or claim an advertised model is live. Record declared response identity separately.
- Keep first-pass reviews isolated. Preserve dissent, evidence references and immutable prior versions.
- Model output is untrusted data, never instructions to execute tools, shell or external writes.
- Budget reservations must be persisted before dispatch. Lost/aborted requests retain conservative accounting.
- Tests must cover state recovery, cancellation, scope isolation, budget concurrency and output validation.
- After code changes, the final verification command is `pnpm typecheck` at this repository root.
- Use full legal names if adding any company examples. Prefer neutral examples without company names.
- Chinese/English mixed UI text uses the normal sans-serif font stack.
