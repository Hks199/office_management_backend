import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3PhotoStorage } from '../files/s3-storage.js';
import type { StoredPhoto } from '../files/file.model.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { AppConfig } from '../../config/env.js';
export interface CommercialStorage {
  upload(file: StoredPhoto): Promise<{ url: string; fields: Record<string, string> }>;
  verifyCsv(file: StoredPhoto): Promise<string>;
  open(file: StoredPhoto, versionId: string): Promise<Readable>;
  write(file: StoredPhoto, body: Buffer): Promise<string>;
  download(file: StoredPhoto, versionId: string): Promise<string>;
}
export class S3CommercialStorage extends S3PhotoStorage implements CommercialStorage {
  // csvRecords owns its upstream-read deadline; socket inactivity would also count intentional DB backpressure.
  constructor(config: AppConfig) { super(config, 0); }
  async verifyCsv(file: StoredPhoto): Promise<string> {
    await this.secureBucket(file.bucket);
    const head = await this.storageRequest(() => this.client.send(new HeadObjectCommand({ Bucket: file.bucket, Key: file.objectKey, ChecksumMode: 'ENABLED' })));
    if (head.ContentLength !== file.size || head.ContentType !== 'text/csv' || head.ChecksumSHA256 !== file.checksumSHA256 || !head.VersionId || head.VersionId === 'null' || !head.ServerSideEncryption) {
      throw new AppError(400, 'INVALID_CSV_FILE', 'CSV metadata does not match its upload intent');
    }
    return head.VersionId;
  }
  async open(file: StoredPhoto, versionId: string): Promise<Readable> {
    await this.secureBucket(file.bucket);
    const result = await this.storageRequest(() => this.client.send(new GetObjectCommand({ Bucket: file.bucket, Key: file.objectKey, VersionId: versionId })));
    if (!(result.Body instanceof Readable) || result.ContentLength !== file.size) {
      if (result.Body instanceof Readable) result.Body.destroy(); throw new AppError(400, 'INVALID_CSV_FILE', 'CSV version size changed or the stream is unavailable');
    }
    return result.Body;
  }
  async write(file: StoredPhoto, body: Buffer): Promise<string> {
    await this.secureBucket(file.bucket);
    if (body.length !== file.size || createHash('sha256').update(body).digest('base64') !== file.checksumSHA256) throw new Error('Export integrity check failed');
    const result = await this.storageRequest(() => this.client.send(new PutObjectCommand({ Bucket: file.bucket, Key: file.objectKey, Body: body,
      ContentLength: file.size, ContentType: 'text/csv', ChecksumSHA256: file.checksumSHA256, ServerSideEncryption: 'AES256' })));
    if (!result.VersionId || result.VersionId === 'null') throw new AppError(503, 'STORAGE_UNSAFE', 'A versioned export is required'); return result.VersionId;
  }
}
