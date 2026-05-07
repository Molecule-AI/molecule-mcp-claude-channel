// tests/setup.ts — preloaded by bunfig.toml's [test].preload before any
// test file is imported. Sets fake values for the three env vars
// server.ts requires at top-level (MOLECULE_PLATFORM_URL,
// MOLECULE_WORKSPACE_IDS, MOLECULE_WORKSPACE_TOKENS). Without this,
// importing server.ts (which the test files do, to pull
// formatRemovedWorkspaceError + other pure helpers) hits the
// required-config guard at server.ts:92 and calls process.exit(1) —
// killing the test runner before any test runs.
//
// `??=` only assigns when the var is unset, so a developer running
// `bun test` locally with a populated .env file isn't overridden.

process.env.MOLECULE_PLATFORM_URL ??= 'http://localhost:18080'
process.env.MOLECULE_WORKSPACE_IDS ??= 'ws-test-00000000-0000-0000-0000-000000000001'
process.env.MOLECULE_WORKSPACE_TOKENS ??= 'tok-test'
