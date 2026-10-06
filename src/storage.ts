import { mkdir, readFile, writeFile, rename, readdir, open, rm } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { put, get, list, del, BlobError } from '@vercel/blob';

// Durable object storage for the archive and for one-time claims (payment
// replay guard, webhook de-duplication).
//
// On Vercel the filesystem is read-only and every function instance is
// separate, so state lives in Vercel Blob. Locally (no Blob credentials) it
// falls back to a directory on disk.
export interface Storage {
  readonly kind: 'vercel-blob' | 'filesystem';
  put(key: string, body: string | Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string, limit?: number): Promise<string[]>;
  // Atomically create `key` if it does not exist. Returns false if it already
  // exists. Throws on any other storage error so callers can fail closed.
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vercel Blob. Use a *private* store: archived contracts must not be reachable
// by URL. PQVA_BLOB_ACCESS=public is only for stores created as public.
// ---------------------------------------------------------------------------
class BlobStorage implements Storage {
  readonly kind = 'vercel-blob' as const;
  private readonly access = process.env.PQVA_BLOB_ACCESS === 'public' ? ('public' as const) : ('private' as const);
  private readonly prefix = (process.env.PQVA_BLOB_PREFIX ?? 'pqva').replace(/\/+$/, '');

  private path(key: string): string {
    return `${this.prefix}/${key}`;
  }

  async put(key: string, body: string | Buffer, contentType: string): Promise<void> {
    await put(this.path(key), body, {
      access: this.access,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    });
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await get(this.path(key), { access: this.access, useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }

  async list(prefix: string, limit = 1000): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: this.path(prefix), cursor, limit: Math.min(1000, limit - out.length) });
      for (const b of page.blobs) out.push(b.pathname.slice(this.prefix.length + 1));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor && out.length < limit);
    return out;
  }

  async claim(key: string): Promise<boolean> {
    try {
      await put(this.path(key), new Date().toISOString(), {
        access: this.access,
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'text/plain',
      });
      return true;
    } catch (e) {
      if (e instanceof BlobError && /already exists/i.test(e.message)) return false;
      throw e;
    }
  }

  async release(key: string): Promise<void> {
    await del(this.path(key));
  }
}

// ---------------------------------------------------------------------------
// Local directory (development, self-hosting on a normal server).
// ---------------------------------------------------------------------------
class FsStorage implements Storage {
  readonly kind = 'filesystem' as const;
  private readonly root = path.resolve(process.env.PQVA_ARCHIVE_DIR ?? 'archive');

  private file(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error(`invalid storage key: ${key}`);
    return resolved;
  }

  async put(key: string, body: string | Buffer): Promise<void> {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async list(prefix: string, limit = 1000): Promise<string[]> {
    const dir = this.file(prefix.replace(/\/+$/, '') || '.');
    try {
      const names = await readdir(dir);
      return names
        .filter(n => !n.endsWith('.tmp'))
        .slice(0, limit)
        .map(n => path.posix.join(prefix.replace(/\/+$/, ''), n));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async claim(key: string): Promise<boolean> {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const fh = await open(target, 'wx');
      await fh.writeFile(new Date().toISOString());
      await fh.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }

  async release(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}

let instance: Storage | undefined;

export function getStorage(): Storage {
  if (!instance) {
    const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
    instance = useBlob ? new BlobStorage() : new FsStorage();
  }
  return instance;
}
