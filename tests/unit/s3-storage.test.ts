import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, GetBucketVersioningCommand, GetPublicAccessBlockCommand,
  GetBucketEncryptionCommand, ListObjectVersionsCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { S3CommercialStorage } from '../../src/modules/csv-imports/commercial-storage.js';
import { S3PhotoStorage, matchesSignature } from '../../src/modules/files/s3-storage.js';
import { testConfig } from '../helpers.js';
const mocks = vi.hoisted(() => ({ send: vi.fn<(command: unknown) => Promise<unknown>>(),
  post: vi.fn<(client: unknown, options: unknown) => Promise<{ url: string; fields: Record<string, string> }>>(),
  sign: vi.fn<(client: unknown, command: unknown, options: unknown) => Promise<string>>() }));
vi.mock('@aws-sdk/client-s3', async (original) => ({ ...await original<typeof import('@aws-sdk/client-s3')>(), S3Client: class { send = mocks.send; } }));
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: mocks.post }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mocks.sign }));
const photo = { bucket: 'test-private-photos', objectKey: 'sunvika/attendance/server-generated.png', contentType: 'image/png', size: 32, checksumSHA256: Buffer.alloc(32).toString('base64') };
const config = testConfig({ awsRegion: 'ap-south-1', s3Bucket: photo.bucket });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function head(overrides: Record<string, unknown> = {}) { return { ContentLength: 32, ContentType: 'image/png', ChecksumSHA256: photo.checksumSHA256, VersionId: 'version-1', ServerSideEncryption: 'AES256', ...overrides }; }
function range(bytes = png, overrides: Record<string, unknown> = {}) { return { ContentLength: 32, ContentRange: 'bytes 0-31/32',
  Body: Object.assign(Readable.from([bytes]), { transformToByteArray: () => Promise.resolve(bytes) }), ...overrides }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.post.mockResolvedValue({ url: 'https://s3.example.invalid', fields: {} }); mocks.sign.mockResolvedValue('signed-url');
  mocks.send.mockImplementation((command) => {
    if (command instanceof GetBucketVersioningCommand) return Promise.resolve({ Status: 'Enabled' });
    if (command instanceof GetPublicAccessBlockCommand) return Promise.resolve({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } });
    if (command instanceof GetBucketEncryptionCommand) return Promise.resolve({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } });
    if (command instanceof HeadObjectCommand) return Promise.resolve(head());
    if (command instanceof GetObjectCommand) return Promise.resolve(range());
    if (command instanceof ListObjectVersionsCommand) return Promise.resolve({ Versions: [{ Key: photo.objectKey, VersionId: 'v1' }], DeleteMarkers: [{ Key: photo.objectKey, VersionId: 'marker' }], IsTruncated: false });
    if (command instanceof DeleteObjectCommand) return Promise.resolve({});
    return Promise.reject(new Error('Unexpected storage command'));
  });
});
it('creates exact-size checksum-bound encrypted POST policies and short version-bound downloads', async () => {
  const storage = new S3PhotoStorage(config); await storage.upload(photo);
  expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({ Expires: 300, Bucket: photo.bucket, Key: photo.objectKey });
  const options = mocks.post.mock.calls[0]?.[1] as { Conditions: unknown[] };
  expect(options.Conditions).toContainEqual(['content-length-range', 32, 32]);
  expect(options.Conditions).toContainEqual(['eq', '$x-amz-checksum-sha256', photo.checksumSHA256]);
  await storage.download(photo, 'version-1');
  const command = mocks.sign.mock.calls[0]?.[1]; expect(command).toBeInstanceOf(GetObjectCommand);
  if (command instanceof GetObjectCommand) expect(command.input).toMatchObject({ VersionId: 'version-1', ResponseContentDisposition: 'attachment', ResponseCacheControl: 'private, no-store' });
  expect(mocks.sign.mock.calls[0]?.[2]).toEqual({ expiresIn: 60 });
});
it('checks S3 metadata/checksum then reads only the signature of the exact immutable version', async () => {
  expect(await new S3PhotoStorage(config).verify(photo)).toBe('version-1');
  const command = mocks.send.mock.calls.map(([cmd]) => cmd).find((cmd) => cmd instanceof GetObjectCommand);
  expect(command?.input).toMatchObject({ VersionId: 'version-1', Range: 'bytes=0-31' });
});
it('fails closed for unconfigured, unversioned, public or unencrypted buckets', async () => {
  await expect(new S3PhotoStorage(testConfig()).upload(photo)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  for (const broken of [{ Status: 'Suspended' }, { PublicAccessBlockConfiguration: { BlockPublicAcls: true } }, {}]) {
    const original = mocks.send.getMockImplementation();
    if (!original) throw new Error('Missing mock');
    const target = 'Status' in broken ? GetBucketVersioningCommand : 'PublicAccessBlockConfiguration' in broken ? GetPublicAccessBlockCommand : GetBucketEncryptionCommand;
    mocks.send.mockImplementation((command) => command instanceof target ? Promise.resolve(broken) : original(command));
    await expect(new S3PhotoStorage(config).upload(photo)).rejects.toMatchObject({ code: 'STORAGE_UNSAFE' });
    mocks.send.mockImplementation(original);
  }
});
it.each([
  ['AccessDenied', 'STORAGE_ACCESS_DENIED'],
  ['CredentialsProviderError', 'STORAGE_CREDENTIALS_INVALID'],
  ['SignatureDoesNotMatch', 'STORAGE_CREDENTIALS_INVALID'],
  ['PermanentRedirect', 'STORAGE_REGION_MISMATCH'],
  ['NoSuchBucket', 'STORAGE_BUCKET_NOT_FOUND'],
  ['TimeoutError', 'STORAGE_REQUEST_FAILED'],
])('returns a safe actionable error for AWS %s during CSV upload', async (name, code) => {
  mocks.send.mockRejectedValue(Object.assign(new Error('private provider credentials and request details'), { name }));
  const error: unknown = await new S3CommercialStorage(config).upload({ ...photo, contentType: 'text/csv' }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ statusCode: 503, code });
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).not.toContain('private provider');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('rejects size, MIME, checksum, missing version/encryption and signature mismatches', async () => {
  const original = mocks.send.getMockImplementation(); if (!original) throw new Error('Missing mock');
  for (const fields of [{ ContentLength: 100 }, { ContentType: 'text/html' }, { ChecksumSHA256: 'wrong' }, { VersionId: 'null' }, { ServerSideEncryption: undefined }]) {
    mocks.send.mockImplementation((command) => command instanceof HeadObjectCommand ? Promise.resolve(head(fields)) : original(command));
    await expect(new S3PhotoStorage(config).verify(photo)).rejects.toMatchObject({ code: 'INVALID_PHOTO' });
  }
  mocks.send.mockImplementation((command) => command instanceof GetObjectCommand ? Promise.resolve(range(Buffer.from('<html>bad</html>'))) : original(command));
  await expect(new S3PhotoStorage(config).verify(photo)).rejects.toMatchObject({ code: 'INVALID_PHOTO' });
  mocks.send.mockImplementation((command) => command instanceof GetObjectCommand ? Promise.resolve(range(png, { ContentRange: undefined, ContentLength: 10000000 })) : original(command));
  await expect(new S3PhotoStorage(config).verify(photo)).rejects.toMatchObject({ code: 'INVALID_PHOTO' });
});
it('recognizes only allowed image signatures', () => {
  expect(matchesSignature(png, 'image/png')).toBe(true); expect(matchesSignature(Buffer.from([255, 216, 255]), 'image/jpeg')).toBe(true);
  expect(matchesSignature(Buffer.from('RIFFxxxxWEBP'), 'image/webp')).toBe(true); expect(matchesSignature(Buffer.from('RIFFxxxxBAD!'), 'image/webp')).toBe(false);
  expect(matchesSignature(png, 'image/jpeg')).toBe(false); expect(matchesSignature(Buffer.alloc(0), 'image/png')).toBe(false);
});
it('deletes every exact-key version and delete marker for an orphan', async () => {
  await new S3PhotoStorage(config).remove(photo);
  expect(mocks.send.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof DeleteObjectCommand).map((cmd) => cmd.input.VersionId)).toEqual(['v1', 'marker']);
});
it('verifies CSV metadata and opens only the confirmed immutable full-size stream', async () => {
  const original = mocks.send.getMockImplementation(); if (!original) throw new Error('Missing mock');
  mocks.send.mockImplementation((command) => command instanceof HeadObjectCommand ? Promise.resolve(head({ ContentType: 'text/csv' })) : original(command));
  const storage = new S3CommercialStorage(config); const csv = { ...photo, contentType: 'text/csv' };
  expect(await storage.verifyCsv(csv)).toBe('version-1');
  const stream = await storage.open(csv, 'version-1'); expect(stream).toBeInstanceOf(Readable); stream.destroy();
  const get = mocks.send.mock.calls.map(([cmd]) => cmd).find((command) => command instanceof GetObjectCommand);
  expect(get?.input).toMatchObject({ VersionId: 'version-1' }); expect(get?.input.Range).toBeUndefined();
  mocks.send.mockImplementation((command) => command instanceof GetObjectCommand ? Promise.resolve(range(png, { ContentLength: 999 })) : original(command));
  await expect(storage.open(csv, 'version-1')).rejects.toMatchObject({ code: 'INVALID_CSV_FILE' });
});
it('translates S3 HEAD 403 errors without a provider name during import confirmation', async () => {
  const original = mocks.send.getMockImplementation(); if (!original) throw new Error('Missing mock');
  mocks.send.mockImplementation((command) => command instanceof HeadObjectCommand
    ? Promise.reject(Object.assign(new Error('private request details'), { name: 'Unknown', $metadata: { httpStatusCode: 403 } })) : original(command));
  await expect(new S3CommercialStorage(config).verifyCsv({ ...photo, contentType: 'text/csv' })).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_ACCESS_DENIED' });
  await expect(new S3PhotoStorage(config).verify(photo)).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_ACCESS_DENIED' });
});
it('translates denied object reads and writes after bucket security checks succeed', async () => {
  const original = mocks.send.getMockImplementation(); if (!original) throw new Error('Missing mock');
  mocks.send.mockImplementation((command) => command instanceof GetObjectCommand || command instanceof PutObjectCommand
    ? Promise.reject(Object.assign(new Error('private request details'), { name: 'AccessDenied' })) : original(command));
  const storage = new S3CommercialStorage(config);
  await expect(storage.open({ ...photo, contentType: 'text/csv' }, 'version-1')).rejects.toMatchObject({ code: 'STORAGE_ACCESS_DENIED' });
  const body = Buffer.from('Code,Name\nSV,Fixture\n');
  await expect(storage.write({ ...photo, contentType: 'text/csv', size: body.length, checksumSHA256: createHash('sha256').update(body).digest('base64') }, body)).rejects.toMatchObject({ code: 'STORAGE_ACCESS_DENIED' });
});
it('rejects mismatched CSV metadata and requires encrypted checksum-bound versioned export writes', async () => {
  const storage = new S3CommercialStorage(config);
  await expect(storage.verifyCsv({ ...photo, contentType: 'text/csv' })).rejects.toMatchObject({ code: 'INVALID_CSV_FILE' });
  const original = mocks.send.getMockImplementation(); if (!original) throw new Error('Missing mock');
  mocks.send.mockImplementation((command) => command instanceof PutObjectCommand ? Promise.resolve({ VersionId: 'export-version' }) : original(command));
  const body = Buffer.from('Code,Name\r\nSV,Fixture\r\n'); const csv = { ...photo, contentType: 'text/csv', size: body.length, checksumSHA256: createHash('sha256').update(body).digest('base64') };
  expect(await storage.write(csv, body)).toBe('export-version');
  const put = mocks.send.mock.calls.map(([cmd]) => cmd).find((command) => command instanceof PutObjectCommand);
  expect(put?.input).toMatchObject({ ContentLength: body.length, ContentType: 'text/csv', ChecksumSHA256: csv.checksumSHA256, ServerSideEncryption: 'AES256' });
  await expect(storage.write(csv, Buffer.from('tampered'))).rejects.toThrow('integrity');
  mocks.send.mockImplementation((command) => command instanceof PutObjectCommand ? Promise.resolve({ VersionId: 'null' }) : original(command));
  await expect(storage.write(csv, body)).rejects.toMatchObject({ code: 'STORAGE_UNSAFE' });
});
