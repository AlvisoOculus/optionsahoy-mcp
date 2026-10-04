// AlphaLatitude Inc. © 2026
//
// Prompt names called as tools. Agents read prompts/list and then invoke a
// prompt's name through tools/call (optimize-iso-exercise: 64 calls, 62
// failures in the 30 days to 2026-10-04, after #257 had already added a "call
// the X tool instead" hint, which most callers did not follow). A prompt that
// drives exactly one tool now runs that tool. Prompts spanning several tools
// (plan-equity-portfolio) keep the hint.

import { PROMPTS } from './mcp-prompts';

// The tool a prompt drives, read from its own "Uses the <tool> tool." sentence
// (the same source the hint uses), so there is no second mapping to drift.
export function toolForPrompt(name: string): string | null {
  const prompt = PROMPTS.find((p) => p.name === name);
  return prompt?.description.match(/Uses the (\w+) tool/)?.[1] ?? null;
}

// Prompt arguments use `state`; the tools take `stateCode` (same two-letter
// code). Every other prompt argument already matches a tool field by name, or
// is rejected by the tool with the field it does want.
export function adaptPromptArgs(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const o = args as Record<string, unknown>;
  if (o.state === undefined || o.stateCode !== undefined) return o;
  const { state, ...rest } = o;
  return { ...rest, stateCode: state };
}
