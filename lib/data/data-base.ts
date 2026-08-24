// AlphaLatitude Inc. © 2026
//
// The public R2 origin every published-artifact reader fetches from, and the
// one knob that moves them together.
//
// This lives in its own file because it was copied into two readers before it
// was shared, and the comment in each claimed what only a shared constant can
// deliver: that pointing a staging or preview deployment at another origin
// moves ALL of them. Three copies that happen to agree are not that promise.
//
// The `typeof process` guard is the load-bearing part. ./chains.ts (the
// browser/Next-only reader, kept as a mirror of the web repo's copy) can read
// `process.env` directly; these readers also load inside a Cloudflare Pages
// Function, where a bare `process` reference throws unless nodejs_compat is on.
export const DATA_BASE =
  (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_OA_DATA_BASE : undefined) ??
  'https://data.optionsahoy.com';
