// Offline receiving-caller replay, not a dispatch or producer/scheduler test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const [actions, policySource, binary] = process.argv.slice(2).map(p => path.resolve(p));
const fixture = JSON.parse(fs.readFileSync('.github/agentic-job/config-test/tests/excluded-fix.json'));
const read = p => fs.readFileSync(p, 'utf8');
const revision = dir => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(revision(policySource), fixture.policy_revision);
assert.equal(execFileSync('git', ['-C', policySource, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }), '', 'policy source must be unmodified');
assert.match(execFileSync(binary, ['--version'], { encoding: 'utf8' }), /^agentic-job 0\.6\.10\s*$/);
const caller = read('.github/workflows/dispatch.yml');
const policy = read(path.join(policySource, '.github/workflows/policy.yml'));

function step(workflow, name) {
  const after = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(after, name);
  const body = after.split('        run: |\n')[1];
  assert.ok(body, name);
  return body.split('\n').slice(0, body.split('\n').findIndex(line => line && !line.startsWith('          ')))
    .map(line => line.slice(10)).join('\n') + '\n';
}

for (const line of [
  '      fix-allow: ${{ steps.bounds.outputs.fix-allow }}',
  '      fix-allow: ${{ needs.profile.outputs.fix-allow }}',
]) assert.ok(caller.includes(line), line);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-fix-caller-'));
try {
  fs.mkdirSync(path.join(temp, 'bin'));
  fs.symlinkSync(binary, path.join(temp, 'bin/agentic-job'));
  fs.mkdirSync(path.join(temp, '.github/agentic-job'), { recursive: true });
  fs.copyFileSync('.github/agentic-job/config-test/tests/incident-fix.toml', path.join(temp, '.github/agentic-job/fix.toml'));
  const output = path.join(temp, 'output');
  const shell = (script, env, cwd = process.cwd()) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    encoding: 'utf8', timeout: 30000, cwd,
    // No credentials or inherited forge/inference configuration. The policy
    // compiler needs no transport for these recorded, already-resolved inputs.
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, JOB_DIR: temp,
      GITHUB_REPOSITORY: fixture.request.REPO, ...env },
  });
  fs.writeFileSync(output, '');
  const bounds = shell(step(caller, 'Resolve the bounds'), { KIND: 'fix', REPO: fixture.request.REPO });
  assert.equal(bounds.status, 0, bounds.stderr);
  const resolved = Object.fromEntries(read(output).trim().split('\n').map(line => line.split('=')));
  assert.deepEqual(resolved, { allow: '.github/agentic-job/dispatch.toml', 'fix-allow': '.github/agentic-job/fix.toml' });
  let allow;
  const check = step(policy, "Check the request against the caller's bounds");
  function replay(run, branch = fixture.request.PUSH_BRANCH) {
    fs.writeFileSync(output, '');
    return shell(check, { ...fixture.request, ALLOW: allow,
      REPLACEMENT_BASE: run.replacement_base, PUSH_BRANCH: branch }, temp);
  }
  for (const run of fixture.runs) {
    // Read immutable objects without changing or executing the checkout.
    const wrapper = execFileSync('git', ['-C', actions, 'show',
      `${run.wrapper_revision}:.github/workflows/cgwalters-agentic-job.yml`], { encoding: 'utf8' });
    assert.ok(wrapper.includes(`policy.yml@${fixture.policy_revision}`));
    assert.match(wrapper, /agent:\n    needs: \[target, policy\]\n    if: \$\{\{ needs.policy.outputs.admitted == 'true' \}\}/);
    assert.match(wrapper, /apply:\n    needs: \[policy, agent, check, session\]/);
    // Evaluate the real wrapper expression, not a second bounds selector.
    const expression = /\n      allow: \$\{\{ (.*?) \}\}/.exec(wrapper)[1];
    const select = new Function('inputs', `return ${expression.replaceAll('inputs.fix-allow', "inputs['fix-allow']")}`);
    allow = select({ kind: 'fix', ...resolved });
    assert.equal(allow, '.github/agentic-job/fix.toml');
    const refused = replay(run);
    assert.equal(refused.status, 1, refused.stderr);
    assert.ok(refused.stderr.includes(fixture.refusal), refused.stderr);
    assert.equal(read(path.join(temp, 'policy.json')), '', 'no compiled policy reaches agent/check/apply');
    assert.equal(read(output), '', 'refusal emits no usable policy outputs');
    const repeated = replay(run);
    assert.equal(repeated.status, refused.status);
    assert.equal(repeated.stderr, refused.stderr, 'identical request is still refused, not retried live');
    // Synthetic positive control: proves refusal is branch-specific, not a
    // broken binary, unknown option or a blanket-refusal stand-in.
    const admitted = replay(run, 'dispatch/offline-control');
    assert.equal(admitted.status, 0, admitted.stderr);
    const compiled = JSON.parse(read(path.join(temp, 'policy.json')));
    assert.equal(compiled.base, 'dispatch/offline-control');
    assert.equal(compiled.safe_outputs.push_to_pull_request_branch.replacement_base, run.replacement_base);
    console.log(`ok offline receiving caller ${run.url}: fix.toml, excluded branch and identical repeat refused; synthetic control accepted`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
