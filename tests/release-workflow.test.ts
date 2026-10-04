// AlphaLatitude Inc. © 2026
//
// npm-publish.yml has three entry points and they must stay equivalent.
//
// `release: published` is the human one. The dispatch-with-a-tag one exists
// because the monthly release routine cannot reach the last step of its own
// job: CCR gives it no `gh` CLI, the egress proxy blocks api.github.com, and
// the GitHub MCP server has no create-release tool. On 2026-09-01 it merged
// the 1.10.2 version bump, could not cut the release, sent a push
// notification instead, and npm plus the MCP registry stayed on 1.10.1 while
// registry-freshness went red every morning for five days.
//
// The dispatch was still a step the routine had to remember, and on
// 2026-10-01 it merged the 1.10.3 bump and stopped again. So the third entry
// point is the bump itself: a push to main that changes package.json to a
// version with no release resolves to that tag and runs the dispatch path.
// Every gate therefore reads the RESOLVED tag; `inputs.tag` is empty on a
// push, and a gate still reading it would skip the release it was meant to
// cut.
//
// The subtle part is the job graph. create-release is SKIPPED on the release
// path, and a skipped `needs` dependency skips its dependents under the
// default success() gate - so the release path would silently stop shipping
// the .mcpb asset and the registry update. `!failure()` is what keeps those
// jobs alive across a skip while still blocking them after a real failure.
// That distinction is invisible until a release is cut, so it is asserted
// here instead.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const WORKFLOW = readFileSync('.github/workflows/npm-publish.yml', 'utf8');

/**
 * The body of one top-level job, from its `  name:` line to the next one, or
 * '' when the job is gone. Empty rather than thrown: these are read at
 * collection time, and throwing there collapses the whole file into one
 * "failed suite" line instead of showing which invariants broke.
 */
function job(name: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// Jobs that must not run outside a release: they attach an asset to one, or
// announce one to the world.
const RELEASE_ONLY = ['mcpb', 'registry'];

describe('every entry point', () => {
  it.each(['resolve', 'create-release', 'publish', 'publish-ai-sdk', 'mcpb', 'registry'])(
    'job %s exists',
    (name) => {
      expect(job(name), `job "${name}" is missing from npm-publish.yml`).not.toBe('');
    },
  );

  it('still publishes on a published release', () => {
    expect(WORKFLOW).toMatch(/on:\n\s+release:\n\s+types: \[published\]/);
  });

  it('accepts a tag to cut on dispatch', () => {
    expect(WORKFLOW).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+tag:/);
  });

  it('wakes up when a version bump lands on main', () => {
    expect(WORKFLOW).toMatch(/\n {2}push:\n {4}branches: \[main\]\n {4}paths: \['package\.json'\]/);
  });

  it('reads the dispatch input in one place only', () => {
    // Anywhere else, `inputs.tag` is the push path's blind spot.
    const uses = WORKFLOW.split('\n').filter((l) => l.includes('inputs.tag'));
    expect(uses).toEqual(['          INPUT_TAG: ${{ inputs.tag }}']);
  });
});

describe('resolve', () => {
  const body = job('resolve');

  it('publishes the tag it resolved', () => {
    expect(body).toMatch(/outputs:\n\s+tag: \$\{\{ steps\.r\.outputs\.tag \}\}/);
    expect(body).toContain('echo "tag=$tag" >> "$GITHUB_OUTPUT"');
  });

  it('takes the input on dispatch', () => {
    expect(body).toMatch(/workflow_dispatch \]; then\n\s+tag="\$INPUT_TAG"/);
  });

  it('on a push, resolves package.json only when that release does not exist', () => {
    // Without the existence check, every package.json edit (a dependency
    // bump) would re-run the registry publish for an already-released version.
    expect(body).toMatch(/push \]; then\n\s+v="v\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
    expect(body).toMatch(/if gh release view "\$v"/);
    expect(body).toMatch(/elif grep -q 'release not found' view-err\.txt; then\n\s+tag="\$v"/);
  });

  it('treats an unreadable release list as an error, not as "unreleased"', () => {
    // A transient API failure read as "missing" would re-cut and re-announce.
    expect(body).toMatch(/else\n\s+echo "gh release view failed[^\n]*exit 1\n\s+fi/);
  });

  it('fails loudly rather than resolving to nothing', () => {
    expect(body).toContain('set -euo pipefail');
  });
});

describe('create-release', () => {
  const body = job('create-release');

  it('only runs when a tag was resolved (dispatch, or a version bump)', () => {
    expect(body).toMatch(/^\s+needs: resolve$/m);
    expect(body).toMatch(/^\s+if: needs\.resolve\.outputs\.tag != ''$/m);
    expect(body).toContain('TAG: ${{ needs.resolve.outputs.tag }}');
  });

  it('refuses a tag that does not match package.json', () => {
    // Otherwise a typo cuts v1.10.3 pointing at a 1.10.2 tree, and npm and
    // the registry disagree with the release for good.
    expect(body).toContain('require(\'./package.json\').version');
    expect(body).toMatch(/if \[ "\$TAG" != "\$version" \]/);
    expect(body).toContain('exit 1');
  });

  it('is idempotent when the release already exists', () => {
    expect(body).toMatch(/gh release view "\$TAG"/);
  });

  it('can write the release it is there to create', () => {
    expect(body).toMatch(/permissions:\n\s+contents: write/);
  });
});

describe.each(RELEASE_ONLY)('%s', (name) => {
  const body = job(name);

  it('waits for the release to be cut', () => {
    expect(body).toMatch(/^\s+needs: \[resolve, create-release\]$/m);
  });

  it('survives create-release being skipped, but not it failing', () => {
    const cond = body.match(/^\s+if: (.+)$/m)?.[1] ?? '';
    expect(cond, 'a skipped dependency skips dependents without this').toContain('!failure()');
    expect(cond).toContain('!cancelled()');
  });

  it('runs on every entry point that has a release, and nowhere else', () => {
    const cond = body.match(/^\s+if: (.+)$/m)?.[1] ?? '';
    expect(cond).toContain("github.event_name == 'release'");
    expect(cond).toContain("needs.resolve.outputs.tag != ''");
  });
});

describe('mcpb asset upload', () => {
  it('names the tag from whichever entry point supplied it', () => {
    // `github.event.release.tag_name` is null on a dispatch run, which would
    // upload the bundle to a release called "".
    expect(job('mcpb')).toContain(
      '${{ github.event.release.tag_name || needs.resolve.outputs.tag }}',
    );
  });
});

describe.each(['publish', 'publish-ai-sdk'])('npm job %s', (name) => {
  const body = job(name);

  it('does not wait on create-release', () => {
    // Version-keyed and skip-existing, so safe on a bare dispatch with no
    // tag - the "republish this commit" case - and not hostage to a tag typo.
    expect(body).not.toMatch(/^\s+needs:.*create-release/m);
  });

  it('publishes nothing on a package.json push that is not a version bump', () => {
    expect(body).toMatch(/^\s+needs: resolve$/m);
    expect(body).toMatch(
      /^\s+if: github\.event_name != 'push' \|\| needs\.resolve\.outputs\.tag != ''$/m,
    );
  });
});
