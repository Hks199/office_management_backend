import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const env = { ...process.env, JWT_SECRET: randomBytes(48).toString('hex'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const project = `sunvika-smoke-${randomBytes(8).toString('hex')}`;
const compose = ['compose', '--project-name', project, '--file', 'docker-compose.smoke.yml'];
async function run(args: string[], label: string, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', (chunk: Buffer) => { if (capture) output += chunk.toString(); });
    // Provider/Compose failures can contain environment/URI values. Emit labels only.
    child.stderr.resume();
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${label} exceeded its deadline`)); }, 300000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error(`${label}: Docker unavailable`)); });
    child.once('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(output.trim()); else reject(new Error(`${label} failed (${String(code)})`)); });
  });
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
  await run(['info', '--format', '{{.ServerVersion}}'], 'Docker engine preflight');
  try {
    await run([...compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'mongo'], 'Replica set startup');
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
  } finally {
    // Only the randomly named project created by this invocation; no deployment resources.
    await run([...compose, 'down', '--volumes', '--remove-orphans'], 'Isolated smoke cleanup');
  }
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Container smoke failed'}\n`); process.exitCode = 1; });
