import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

const root = resolve(__dirname, '..');
const configPath = join(root, '.devcontainer/devcontainer.json');
const scriptPath = join(root, '.devcontainer/setup.sh');
const script = readFileSync(scriptPath, 'utf8');

test('devcontainer.json exists', () => {
  assert.ok(existsSync(configPath));
});

test('devcontainer.json parses and configures the creation hook', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.postCreateCommand, 'bash .devcontainer/setup.sh');
  assert.equal(config.remoteUser, 'codespace');
  assert.deepEqual(config.forwardPorts, [3000]);
});

test('Node 20 and Python 3.11 features are configured', () => {
  const { features } = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(features['ghcr.io/devcontainers/features/node:1'].version, '20');
  assert.equal(features['ghcr.io/devcontainers/features/python:1'].version, '3.11');
});

test('setup.sh exists', () => {
  assert.ok(existsSync(scriptPath));
});

test('setup.sh is executable', () => {
  assert.notEqual(statSync(scriptPath).mode & 0o111, 0);
});

test('README documents automatic setup and the optional video-agent', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const expected of [
    '## إعداد Codespace',
    '5–10',
    'لا يحتوي على',
    'cd tools/video-agent',
    'source .venv/bin/activate',
    'npm start',
    'bash .devcontainer/setup.sh',
  ]) {
    assert.ok(readme.includes(expected), `README missing: ${expected}`);
  }
});

test('gfortran is installed before SciPy', () => {
  const compiler = script.indexOf('  gfortran');
  const scipy = script.indexOf('"$PYTHON" -m pip install scipy');
  assert.ok(compiler >= 0 && scipy > compiler);
});

test('setup.sh has valid Bash syntax', () => {
  const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

// All external installers and downloads are mocked: tests never use sudo,
// install Python packages, or contact the network.
function fixture(t: TestContext, agent = false, packages = false) {
  const directory = mkdtempSync(join(tmpdir(), 'pc-free-devcontainer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const log = join(directory, 'commands.log');
  const agentDir = join(directory, 'tools/video-agent');
  const models = join(agentDir, 'assets/models/piper');
  mkdirSync(bin);
  mkdirSync(join(directory, '.devcontainer'));
  copyFileSync(scriptPath, join(directory, '.devcontainer/setup.sh'));
  writeFileSync(log, '');
  if (agent) mkdirSync(agentDir, { recursive: true });
  if (packages) {
    writeFileSync(join(directory, 'package.json'), '{}');
    if (agent) writeFileSync(join(agentDir, 'package.json'), '{}');
  }
  const stub = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/bash\nset -eu\necho "${name}:$PWD:$*" >> "$TEST_LOG"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub('sudo', 'exit 0');
  stub('npm', 'exit "${FAIL_NPM:-0}"');
  stub('python3.11', `
if [ "$*" = '-m venv .venv' ]; then
  mkdir -p .venv/bin
  cp "$0" .venv/bin/python
fi
exit 0`);
  stub('wget', `
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-O' ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
printf 'mock download' > "$output"
if [ "\${FAIL_MODEL:-0}" = 1 ] && [[ "$output" == *.onnx.part ]]; then
  exit 1
fi`);
  const run = (extraEnv: Record<string, string> = {}) => spawnSync(
    'bash',
    [join(directory, '.devcontainer/setup.sh')],
    {
      cwd: bin, // Ensure the script works from outside the repository root.
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, ...extraEnv },
    },
  );
  return { directory, agentDir, models, run, log: () => readFileSync(log, 'utf8') };
}

test('static repository skips missing packages and does not create video-agent', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.log(), /apt-get install.*gfortran.*ffmpeg/);
  assert.doesNotMatch(f.log(), /npm:|python3\.11:|wget:/);
  assert.ok(!existsSync(f.agentDir));
});

test('root Node project installs even when video-agent is absent', (t) => {
  const f = fixture(t, false, true);
  assert.equal(f.run().status, 0);
  assert.ok(f.log().includes(`npm:${f.directory}:install`));
  assert.doesNotMatch(f.log(), /python3\.11:|wget:/);
});

test('video-agent without a package manifest skips npm but still prepares Python', (t) => {
  const f = fixture(t, true);
  assert.equal(f.run().status, 0);
  assert.doesNotMatch(f.log(), /npm:/);
  assert.match(f.log(), /-m venv .venv/);
});

test('full setup installs CPU-only PyTorch and both model files; reruns reuse downloads', (t) => {
  const f = fixture(t, true, true);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const log = f.log();
  assert.ok(log.includes(`npm:${f.directory}:install`));
  assert.ok(log.includes(`npm:${f.agentDir}:install`));
  assert.ok(log.indexOf('gfortran') < log.indexOf('pip install scipy'));
  assert.match(log, /-m venv .venv/);
  assert.match(log, /pip install torch torchvision --index-url https:\/\/download.pytorch.org\/whl\/cpu/);
  for (const suffix of ['onnx', 'onnx.json']) {
    assert.ok(existsSync(join(f.models, `ar_JO-kareem-medium.${suffix}`)));
  }
  assert.equal(f.run().status, 0);
  assert.equal(f.log().split('\n').filter((line) => line.startsWith('wget:')).length, 2);
});

test('missing config and empty model are downloaded independently', (t) => {
  const f = fixture(t, true);
  assert.equal(f.run().status, 0);
  unlinkSync(join(f.models, 'ar_JO-kareem-medium.onnx.json'));
  assert.equal(f.run().status, 0);
  let downloads = f.log().split('\n').filter((line) => line.startsWith('wget:'));
  assert.equal(downloads.length, 3);
  assert.match(downloads[2], /\.onnx\.json$/);
  writeFileSync(join(f.models, 'ar_JO-kareem-medium.onnx'), '');
  assert.equal(f.run().status, 0);
  downloads = f.log().split('\n').filter((line) => line.startsWith('wget:'));
  assert.equal(downloads.length, 4);
  assert.match(downloads[3], /\.onnx$/);
});

test('failed download warns, removes partial data, and can be retried', (t) => {
  const f = fixture(t, true);
  const result = f.run({ FAIL_MODEL: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /نماذج الصوت غير مكتملة/);
  assert.ok(!existsSync(join(f.models, 'ar_JO-kareem-medium.onnx')));
  assert.ok(!existsSync(join(f.models, 'ar_JO-kareem-medium.onnx.part')));
  assert.ok(existsSync(join(f.models, 'ar_JO-kareem-medium.onnx.json')));
  assert.equal(f.run().status, 0);
  assert.ok(existsSync(join(f.models, 'ar_JO-kareem-medium.onnx')));
});

test('installer errors stop setup rather than reporting success', (t) => {
  const f = fixture(t, true, true);
  const result = f.run({ FAIL_NPM: '42' });
  assert.equal(result.status, 42);
  assert.doesNotMatch(f.log(), /python3\.11:|wget:/);
  assert.doesNotMatch(result.stdout, /✅/);
});
