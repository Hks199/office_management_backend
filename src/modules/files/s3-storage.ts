import { S3Client, HeadObjectCommand, GetObjectCommand, GetBucketVersioningCommand, GetPublicAccessBlockCommand,
  GetBucketEncryptionCommand, ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { StoredPhoto } from './file.model.js';

export interface PhotoStorage {
  upload(photo: StoredPhoto): Promise<{ url: string; fields: Record<string, string> }>;
  verify(photo: StoredPhoto): Promise<string>;
  download(photo: StoredPhoto, versionId: string): Promise<string>;
  remove(photo: StoredPhoto): Promise<void>;
}
export function matchesSignature(bytes: Uint8Array, mime: string): boolean {
  const b = Buffer.from(bytes);
  if (mime === 'image/jpeg') return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return mime === 'image/webp' && b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
}
export class S3PhotoStorage implements PhotoStorage {
  protected readonly client: S3Client;
  protected async storageRequest<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      const name = error instanceof Error ? error.name : '';
      const metadata: unknown = typeof error === 'object' && error !== null && '$metadata' in error ? error.$metadata : null;
      const status = typeof metadata === 'object' && metadata !== null && 'httpStatusCode' in metadata ? metadata.httpStatusCode : undefined;
      if (['AccessDenied', 'AccessDeniedException', 'Forbidden'].includes(name) || status === 403) {
        throw new AppError(503, 'STORAGE_ACCESS_DENIED', 'AWS denied access to private file storage. Ask your administrator to check the backend IAM identity and bucket permissions.');
      }
      if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken', 'CredentialsProviderError'].includes(name)) {
        throw new AppError(503, 'STORAGE_CREDENTIALS_INVALID', 'AWS storage credentials are missing, invalid or expired. Ask your administrator to update the backend credentials.');
      }
      if (['PermanentRedirect', 'AuthorizationHeaderMalformed', 'IllegalLocationConstraintException'].includes(name)) {
        throw new AppError(503, 'STORAGE_REGION_MISMATCH', 'The configured AWS region does not match the storage bucket.');
      }
      if (name === 'NoSuchBucket') throw new AppError(503, 'STORAGE_BUCKET_NOT_FOUND', 'The configured storage bucket could not be found.');
      throw new AppError(503, 'STORAGE_REQUEST_FAILED', 'Private file storage could not be reached or verified. Ask your administrator to check AWS access and connectivity.');
    }
  }
  constructor(private readonly config: AppConfig, socketTimeoutMs = 10000) {
    this.client = new S3Client({ ...(config.awsRegion ? { region: config.awsRegion } : {}), maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000, throwOnRequestTimeout: true, socketTimeout: socketTimeoutMs } });
  }
  protected async secureBucket(bucket: string): Promise<void> {
    if (!this.config.s3Bucket || !this.config.awsRegion || bucket !== this.config.s3Bucket) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Private photo storage is not configured');
    const [versioning, publicAccess, encryption] = await this.storageRequest(() => Promise.all([
      this.client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
      this.client.send(new GetPublicAccessBlockCommand({ Bucket: bucket })),
      this.client.send(new GetBucketEncryptionCommand({ Bucket: bucket })),
    ]));
    const block = publicAccess.PublicAccessBlockConfiguration;
    if (versioning.Status !== 'Enabled' || !block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets ||
      !encryption.ServerSideEncryptionConfiguration?.Rules?.some((rule) => ['AES256', 'aws:kms', 'aws:kms:dsse'].includes(rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? ''))) {
      throw new AppError(503, 'STORAGE_UNSAFE', 'Photo bucket must enable versioning, encryption and all public access blocks');
    }
  }
  async upload(photo: StoredPhoto) {
    await this.secureBucket(photo.bucket);
    return createPresignedPost(this.client, { Bucket: photo.bucket, Key: photo.objectKey, Expires: 300,
      Fields: { 'Content-Type': photo.contentType, 'x-amz-checksum-algorithm': 'SHA256', 'x-amz-checksum-sha256': photo.checksumSHA256,
        'x-amz-server-side-encryption': 'AES256' },
      Conditions: [['content-length-range', photo.size, photo.size], ['eq', '$Content-Type', photo.contentType],
        ['eq', '$x-amz-checksum-algorithm', 'SHA256'], ['eq', '$x-amz-checksum-sha256', photo.checksumSHA256], ['eq', '$x-amz-server-side-encryption', 'AES256']] });
  }
  async verify(photo: StoredPhoto): Promise<string> {
    await this.secureBucket(photo.bucket);
    const head = await this.storageRequest(() => this.client.send(new HeadObjectCommand({ Bucket: photo.bucket, Key: photo.objectKey, ChecksumMode: 'ENABLED' })));
    if (head.ContentLength !== photo.size || head.ContentType !== photo.contentType || head.ChecksumSHA256 !== photo.checksumSHA256 ||
      !head.VersionId || head.VersionId === 'null' || !head.ServerSideEncryption) throw new AppError(400, 'INVALID_PHOTO', 'Uploaded photo metadata does not match the upload intent');
    const result = await this.storageRequest(() => this.client.send(new GetObjectCommand({ Bucket: photo.bucket, Key: photo.objectKey, VersionId: head.VersionId, Range: 'bytes=0-31' })));
    if (!result.Body) throw new AppError(400, 'INVALID_PHOTO', 'Uploaded photo is empty');
    // Range must be honored before buffering; never download an unbounded object for inspection.
    if (!result.ContentRange || !result.ContentLength || result.ContentLength > 32) {
      if (result.Body instanceof Readable) result.Body.destroy();
      throw new AppError(400, 'INVALID_PHOTO', 'Photo signature response is invalid');
    }
    const bytes = await result.Body.transformToByteArray();
    if (!matchesSignature(bytes, photo.contentType)) throw new AppError(400, 'INVALID_PHOTO', 'Uploaded photo signature does not match its type');
    return head.VersionId;
  }
  async download(photo: StoredPhoto, versionId: string) {
    await this.secureBucket(photo.bucket);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: photo.bucket, Key: photo.objectKey, VersionId: versionId,
      ResponseContentType: photo.contentType, ResponseContentDisposition: 'attachment', ResponseCacheControl: 'private, no-store' }), { expiresIn: 60 });
  }
  async remove(photo: StoredPhoto) {
    await this.secureBucket(photo.bucket);
    // URLs expired at least 24 hours ago and DB state prevents attachment. Drain bounded pages; rerunning resumes safely.
    for (let page = 0; page < 10; page++) {
      const versions = await this.storageRequest(() => this.client.send(new ListObjectVersionsCommand({ Bucket: photo.bucket, Prefix: photo.objectKey, MaxKeys: 1000 })));
      const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].filter((entry) => entry.Key === photo.objectKey && entry.VersionId);
      for (const entry of objects) await this.storageRequest(() => this.client.send(new DeleteObjectCommand({ Bucket: photo.bucket, Key: photo.objectKey, VersionId: entry.VersionId })));
      if (!versions.IsTruncated) return;
    }
    throw new AppError(503, 'CLEANUP_INCOMPLETE', 'Orphan cleanup reached its batch limit; rerun cleanup');
  }
}
