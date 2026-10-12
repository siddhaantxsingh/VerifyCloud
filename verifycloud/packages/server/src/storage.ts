// Object storage (S3-compatible: AWS S3, MinIO, ...). PostgreSQL stores only
// metadata and the object key (artifacts table); bytes live here.
import { Readable } from "node:stream";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import type { ServerConfig } from "./config.js";

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string, contentEncoding?: string): Promise<void>;
  get(key: string, range?: { start: number; end?: number }): Promise<{ body: Readable; size: number; contentRange?: string }>;
  getBuffer(key: string, maxBytes: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
  ping(): Promise<void>;
  ensureBucket(): Promise<void>;
}

export class S3Store implements ObjectStore {
  private client: S3Client;
  constructor(private cfg: ServerConfig["s3"]) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
      maxAttempts: 3,
    });
  }

  async put(key: string, body: Buffer, contentType: string, contentEncoding?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType, ContentEncoding: contentEncoding, ContentLength: body.length }));
  }

  async get(key: string, range?: { start: number; end?: number }) {
    const out: GetObjectCommandOutput = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end ?? ""}` : undefined }),
    );
    return { body: out.Body as Readable, size: Number(out.ContentLength ?? 0), contentRange: out.ContentRange };
  }

  async getBuffer(key: string, maxBytes: number) {
    const { body, size } = await this.get(key);
    if (size > maxBytes) {
      body.destroy();
      throw new Error(`object ${key} is ${size} bytes (limit ${maxBytes})`);
    }
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of body) {
      n += (c as Buffer).length;
      if (n > maxBytes) {
        body.destroy();
        throw new Error(`object ${key} exceeds ${maxBytes} bytes`);
      }
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  async ping() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
  }

  async ensureBucket() {
    try {
      await this.ping();
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
    }
  }
}

/** Object key layout: tenant first, so lifecycle rules and audits can work per organization. */
export const objectKey = (orgId: string, artifactId: string, name: string) =>
  `org/${orgId}/artifacts/${artifactId}/${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}`;
