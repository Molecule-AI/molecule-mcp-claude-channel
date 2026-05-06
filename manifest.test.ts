// manifest.test.ts — pins agreement between the three manifest files
// that all carry the plugin name + version. Drift between them is the
// exact bug class that motivated v0.4 (closes Molecule-AI/molecule-core#3013):
//
//   .claude-plugin/plugin.json   — Claude Code plugin manifest (the install target)
//   .mcp.json                    — MCP server registration (the runtime name users see in /mcp)
//   .claude-plugin/marketplace.json — marketplace catalog (what /plugin install resolves)
//   package.json                 — bun/npm metadata (CI + install)
//
// If a future PR bumps the version in package.json but forgets the
// other three, /plugin install ships an out-of-date manifest. If a
// PR renames the MCP server in .mcp.json but not in marketplace.json,
// the marketplace install path silently no-ops the same way #3013
// did. These assertions fire on either drift.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

const root = new URL('./', import.meta.url).pathname
const plugin = JSON.parse(readFileSync(`${root}.claude-plugin/plugin.json`, 'utf8'))
const marketplace = JSON.parse(readFileSync(`${root}.claude-plugin/marketplace.json`, 'utf8'))
const mcp = JSON.parse(readFileSync(`${root}.mcp.json`, 'utf8'))
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

describe('manifest cross-file consistency', () => {
  test('plugin.json + marketplace.json + .mcp.json all agree on the plugin name', () => {
    // The MCP server name is what shows up in `/mcp` and is what
    // collides with users' pre-existing `molecule` MCP server when
    // wrong (the original #3013 bug).
    const mcpServerNames = Object.keys(mcp.mcpServers)
    expect(mcpServerNames).toHaveLength(1)
    expect(mcpServerNames[0]).toBe(plugin.name)

    // The marketplace's plugins[].name must match plugin.json's name
    // — otherwise `/plugin install <name>@marketplace` silently fails
    // to resolve.
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins[0].name).toBe(plugin.name)
  })

  test('plugin.json + marketplace.json + package.json all agree on the version', () => {
    // Version drift means /plugin shows one version, the wheel/bundle
    // ships another. Pin all three.
    expect(marketplace.plugins[0].version).toBe(plugin.version)
    expect(pkg.version).toBe(plugin.version)
    // metadata.version (marketplace-level) is conventional + helpful;
    // pin it too if present.
    if (marketplace.metadata?.version !== undefined) {
      expect(marketplace.metadata.version).toBe(plugin.version)
    }
  })

  test('plugin name is NOT bare "molecule" (collides with first-party molecule MCP)', () => {
    // Regression guard for #3013 issue 3. The bare name was the
    // original collision; v0.4 picked `molecule-channel`. Any future
    // refactor that reverts the rename without thinking should fail
    // here.
    expect(plugin.name).not.toBe('molecule')
    expect(Object.keys(mcp.mcpServers)).not.toContain('molecule')
    expect(marketplace.plugins[0].name).not.toBe('molecule')
  })

  test('marketplace.json source points at the plugin in this repo', () => {
    // Single-plugin marketplace where the plugin lives at the repo
    // root: source must be "./" (resolved relative to the repo root,
    // i.e. the dir containing .claude-plugin/). A wrong source would
    // make /plugin install fetch the marketplace catalog but fail to
    // locate the plugin manifest.
    expect(marketplace.plugins[0].source).toBe('./')
  })

  test('marketplace.json owner is set (required field for `/plugin marketplace add`)', () => {
    // Per https://code.claude.com/docs/en/plugin-marketplaces#marketplace-schema
    // owner.name is required; without it `/plugin marketplace add`
    // rejects the manifest with a parse error.
    expect(marketplace.owner).toBeDefined()
    expect(marketplace.owner.name).toBeTypeOf('string')
    expect(marketplace.owner.name.length).toBeGreaterThan(0)
  })
})
