import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1',
  JWT_SECRET: randomBytes(48).toString('hex'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
delete env.COMPOSE_ENV_FILES;
const project = `sunvika-smoke-${randomBytes(8).toString('hex')}`;
const compose = ['compose', '--project-name', project, '--file', 'docker-compose.smoke.yml'];
const secretValues = [...new Set(Object.entries(env)
  .filter(([name]) => /password|passwd|secret|token|credential|(?:^|_)key(?:_|$)|(?:^|_)(?:uri|url)$/i.test(name))
  .flatMap(([, value]) => value ? [value, JSON.stringify(value).slice(1, -1), ...value.split(/\r?\n/)] : [])
  .filter(Boolean))].sort((a, b) => b.length - a.length);
function redact(value: string): string {
  for (const secret of secretValues) value = value.split(secret).join('[REDACTED]');
  return value.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s"'<>/]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|token|key|password|secret)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\r\n]+/gi, '$1[REDACTED]');
}
function outputTail() {
  let output = ''; let partial = ''; let discarding = false;
  return {
    append(chunk: string) {
      for (const fragment of chunk.split(/(\r\n|\r|\n)/)) {
        if (/^[\r\n]+$/.test(fragment)) {
          if (!discarding) output = (output + redact(partial) + '\n').slice(-32768);
          partial = ''; discarding = false;
        } else if (!discarding) {
          // Never retain a fragment of an oversized record containing a secret.
          if (partial.length + fragment.length > 32768) {
            output = (output + '[oversized log line omitted]\n').slice(-32768);
            partial = ''; discarding = true;
          } else partial += fragment;
        }
      }
    },
    read() { return output + (discarding ? '' : redact(partial)); },
  };
}
async function run(args: string[], label: string, capture = false, deadlineMs = 300000): Promise<string> {
  if (!capture) process.stdout.write(`${label}...\n`);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = outputTail(); const stderr = outputTail(); let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout.append(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr.append(chunk); });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, deadlineMs);
    child.once('error', () => { clearTimeout(timeout); reject(new Error(`${label}: Docker unavailable`)); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) { resolve(capture ? stdout.read().trim() : ''); return; }
      const detail = [stdout.read(), stderr.read()].join('\n').trim().slice(-8000);
      const failure = timedOut ? `${label} exceeded its deadline` : `${label} failed (${String(code)})`;
      reject(new Error(detail ? `${failure}\n${detail}` : failure));
    });
  });
}
async function diagnoseFailure() {
  const commands: [string[], string][] = [
    [[...compose, 'ps', '--all'], 'Smoke container status'],
    [[...compose, 'logs', '--no-color', '--tail', '60', 'mongo'], 'Smoke MongoDB logs'],
  ];
  for (const [args, label] of commands) {
    try {
      const detail = await run(args, label, true, 15000);
      process.stderr.write(`${label}:\n${detail || '(no container output)'}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : `${label} unavailable`}\n`);
    }
  }
}
async function main() {
  if (process.argv.includes('--config-only')) {
    Object.assign(env, { MONGODB_URI: 'mongodb://test:test@mongo.example.invalid/ci?tls=true&replicaSet=rs0',
      CORS_ORIGINS: 'https://app.example.invalid', CREDENTIAL_UI_ORIGIN: 'https://app.example.invalid',
      AWS_REGION: 'ap-south-1', S3_BUCKET: 'smoke-config-only' });
    await run(['compose', '--file', 'docker-compose.production.yml', 'config', '--quiet'], 'Production Compose validation');
    await run([...compose, 'config', '--quiet'], 'Smoke Compose validation');
    process.stdout.write('Production and isolated smoke Compose configurations validate with synthetic settings.\n');
    return;
  }
  process.stdout.write('Docker engine preflight...\n');
  const engine = await run(['info', '--format', '{{.ServerVersion}} (kernel {{.KernelVersion}}, {{.OperatingSystem}})'],
    'Docker engine preflight', true);
  process.stdout.write(`Docker engine: ${engine}\n`);
  let failed = false;
  let cleanupFailure: Error | undefined;
  try {
    await run([...compose, 'pull', '--policy', 'missing', 'mongo'], 'MongoDB image pull');
    await run([...compose, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120', 'mongo'], 'Replica set startup');
    await run([...compose, 'build', 'api'], 'Production image build');
    await run([...compose, 'run', '--rm', '--no-deps', 'api', 'node', 'dist/scripts/production-indexes.js'], 'Index migration');
    await run([...compose, 'run', '--rm', '--no-deps', 'api', 'node', 'dist/scripts/production-preflight.js'], 'Read-only preflight');
    await run([...compose, 'up', '-d', '--wait', '--wait-timeout', '90', 'api'], 'API readiness');
    await run([...compose, 'exec', '-T', 'api', 'node', '--input-type=module', '-e',
      "if(process.getuid()===0)process.exit(1);for(const [path,status] of [['health/live',200],['health/ready',200],['auth/me',401],['operations/metrics',401],['openapi.json',404]]){const r=await fetch('http://127.0.0.1:3100/api/v1/'+path);if(r.status!==status||r.headers.get('cache-control')!=='no-store')process.exit(1)}"], 'Runtime health/security checks');
    await run([...compose, 'stop', '-t', '15', 'api'], 'SIGTERM drain');
    const id = await run([...compose, 'ps', '-aq', 'api'], 'Container lookup', true);
    if (await run(['inspect', '--format', '{{.State.ExitCode}}', id], 'Exit status', true) !== '0') throw new Error('API did not stop gracefully');
    process.stdout.write('Container build, migration, readiness, non-root/read-only runtime, security and SIGTERM smoke passed.\n');
  } catch (error) {
    failed = true;
    await diagnoseFailure();
    throw error;
  } finally {
    // Only the randomly named project created by this invocation; no deployment resources.
    try { await run([...compose, 'down', '--volumes', '--remove-orphans'], 'Isolated smoke cleanup'); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error('Isolated smoke cleanup failed');
      if (failed) process.stderr.write(`Cleanup also failed: ${failure.message}\n`);
      else cleanupFailure = failure;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Container smoke failed'}\n`); process.exitCode = 1; });
