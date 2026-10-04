// AlphaLatitude Inc. © 2026
import { describe, expect, it } from 'vitest';
import { adaptPromptArgs, toolForPrompt } from '../functions/_lib/prompt-aliases';
import { PROMPTS } from '../functions/_lib/mcp-prompts';
import { TOOLS } from '../functions/_lib/mcp-tools';

describe('toolForPrompt', () => {
  it('maps every single-tool prompt to a real tool', () => {
    const names = new Set<string>(TOOLS.map((t) => t.name));
    const mapped = PROMPTS.map((p) => [p.name, toolForPrompt(p.name)] as const).filter(([, t]) => t);
    expect(mapped.length).toBe(7);
    for (const [, t] of mapped) expect(names.has(t!)).toBe(true);
    expect(toolForPrompt('optimize-iso-exercise')).toBe('amt_iso_optimize');
  });

  it('has no single tool for the portfolio prompt, and nothing for non-prompts', () => {
    expect(toolForPrompt('plan-equity-portfolio')).toBeNull();
    expect(toolForPrompt('amt_iso_optimize')).toBeNull();
  });
});

describe('adaptPromptArgs', () => {
  it('renames state to stateCode', () => {
    expect(adaptPromptArgs({ shares: 1, state: 'CA' })).toEqual({ shares: 1, stateCode: 'CA' });
  });
  it('never overrides an explicit stateCode', () => {
    expect(adaptPromptArgs({ state: 'NY', stateCode: 'CA' })).toEqual({ state: 'NY', stateCode: 'CA' });
  });
  it('passes through anything that is not an argument object', () => {
    expect(adaptPromptArgs(undefined)).toBeUndefined();
    expect(adaptPromptArgs([1])).toEqual([1]);
  });
});
