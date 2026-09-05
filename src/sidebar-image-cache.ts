import type { RasterImageSnapshotV1 } from 'cordisx/contracts';

export type { RasterImageSnapshotV1 } from 'cordisx/contracts';

export const CHATROOM_SIDEBAR_IMAGE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json' as const;
export const CHATROOM_SIDEBAR_IMAGE_CONTRACT = 'cordisx.raster-image-snapshot/v1' as const;

export interface ChatroomSidebarImagePublishRequest {
  readonly roomId: string;
  readonly fingerprint: string;
  readonly generation: number;
  readonly image: RasterImageSnapshotV1;
}

export interface ChatroomSidebarImageCapture {
  readonly roomId: string;
  readonly fingerprint: string;
  readonly generation: number;
  publish(image: RasterImageSnapshotV1): boolean;
}

interface CacheEntry {
  readonly fingerprint: string;
  readonly image: RasterImageSnapshotV1;
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_BASE64_LENGTH = 349_528;
const MAX_DECODED_BYTES = 262_144;
const MAX_DIMENSION = 256;
const SNAPSHOT_KEYS = [
  '$schema',
  'contract',
  'schemaVersion',
  'mediaType',
  'encoding',
  'data',
  'width',
  'height',
] as const;

function hasExactKeys(value: object): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...SNAPSHOT_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length < 4 || value.length > MAX_BASE64_LENGTH || !CANONICAL_BASE64.test(value)) {
    throw new Error('Sidebar image snapshot has invalid base64 data.');
  }
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error('Sidebar image snapshot has invalid base64 data.');
  }
  if (binary.length > MAX_DECODED_BYTES || globalThis.btoa(binary) !== value) {
    throw new Error('Sidebar image snapshot has invalid base64 data.');
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset]! * 0x100 + bytes[offset + 1]!) * 0x100 + bytes[offset + 2]!) * 0x100
    + bytes[offset + 3]!) >>> 0;
}

let crcTable: Uint32Array | undefined;

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    return current >>> 0;
  });
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/** Mirrors the public raster-image/v1 semantic requirements at the producer boundary. */
function assertPng(bytes: Uint8Array, width: number, height: number): void {
  if (bytes.length < 57 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Sidebar image snapshot is not a PNG.');
  }
  let offset: number = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawIdat = false;
  let sawIend = false;
  while (offset < bytes.length) {
    if (sawIend || offset + 12 > bytes.length) {
      throw new Error('Sidebar image PNG has invalid chunk boundaries.');
    }
    const length = uint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + length;
    const end = crcOffset + 4;
    if (length > MAX_DECODED_BYTES || end > bytes.length) {
      throw new Error('Sidebar image PNG has invalid chunk boundaries.');
    }
    const type = chunkName(bytes, typeOffset);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error('Sidebar image PNG has an invalid chunk type.');
    if (pngCrc(bytes, typeOffset, crcOffset) !== uint32(bytes, crcOffset)) {
      throw new Error(`Sidebar image PNG ${type} CRC is invalid.`);
    }
    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('Sidebar image PNG must begin with one IHDR.');
      if (uint32(bytes, dataOffset) !== width || uint32(bytes, dataOffset + 4) !== height) {
        throw new Error('Sidebar image PNG dimensions do not match the declaration.');
      }
      if (bytes[dataOffset + 8] !== 8 || bytes[dataOffset + 9] !== 6) {
        throw new Error('Sidebar image PNG must use 8-bit RGBA pixels.');
      }
      if (bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 || bytes[dataOffset + 12] !== 0) {
        throw new Error('Sidebar image PNG uses an unsupported compression, filter, or interlace method.');
      }
    } else if (type === 'IHDR') {
      throw new Error('Sidebar image PNG has multiple IHDR chunks.');
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw new Error('Animated sidebar PNGs are not supported.');
    }
    if (type === 'IDAT') sawIdat = true;
    if ((bytes[typeOffset]! & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      throw new Error(`Sidebar image PNG has unknown critical chunk ${type}.`);
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || end !== bytes.length) {
        throw new Error('Sidebar image PNG has an invalid IEND.');
      }
      sawIend = true;
    }
    offset = end;
    chunkIndex += 1;
  }
  if (!sawIend) throw new Error('Sidebar image PNG is missing IEND.');
}

function cloneSnapshot(image: RasterImageSnapshotV1): RasterImageSnapshotV1 {
  if (
    image === null || typeof image !== 'object' || Array.isArray(image) || !hasExactKeys(image)
    || image.$schema !== CHATROOM_SIDEBAR_IMAGE_SCHEMA
    || image.contract !== CHATROOM_SIDEBAR_IMAGE_CONTRACT
    || image.schemaVersion !== 1
    || image.mediaType !== 'image/png'
    || image.encoding !== 'base64'
    || !Number.isInteger(image.width)
    || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1
    || image.width > MAX_DIMENSION || image.height > MAX_DIMENSION
    || image.width * image.height > MAX_DIMENSION * MAX_DIMENSION
    || typeof image.data !== 'string'
  ) {
    throw new Error('Sidebar image snapshot is invalid.');
  }
  assertPng(decodeCanonicalBase64(image.data), image.width, image.height);
  return Object.freeze({
    $schema: CHATROOM_SIDEBAR_IMAGE_SCHEMA,
    contract: CHATROOM_SIDEBAR_IMAGE_CONTRACT,
    schemaVersion: 1,
    mediaType: 'image/png',
    encoding: 'base64',
    data: image.data,
    width: image.width,
    height: image.height,
  });
}

/**
 * Product-owned, completed-image-only LRU. A capture obtains an epoch before
 * starting asynchronous work; replacement, eviction, or disposal fences its
 * late result without retaining a Promise or DOM handle in the collection.
 */
export class ChatroomSidebarImageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<(roomId: string) => void>();
  private disposed = false;

  constructor(readonly maximumEntries = 128) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 512) {
      throw new RangeError('Sidebar image cache capacity must be between 1 and 512.');
    }
  }

  begin(roomId: string, fingerprint: string): ChatroomSidebarImageCapture {
    this.assertKey(roomId, fingerprint);
    if (this.disposed) throw new Error('Sidebar image cache is disposed.');
    const retained = this.entries.get(roomId);
    if (retained !== undefined && retained.fingerprint !== fingerprint) this.entries.delete(roomId);
    const generation = (this.generations.get(roomId) ?? 0) + 1;
    this.rememberGeneration(roomId, generation);
    return Object.freeze({
      roomId,
      fingerprint,
      generation,
      publish: (image: RasterImageSnapshotV1) => this.publish({ roomId, fingerprint, generation, image }),
    });
  }

  publish(request: ChatroomSidebarImagePublishRequest): boolean {
    this.assertKey(request.roomId, request.fingerprint);
    if (this.disposed || this.generations.get(request.roomId) !== request.generation) return false;
    const image = cloneSnapshot(request.image);
    this.entries.delete(request.roomId);
    this.entries.set(request.roomId, Object.freeze({ fingerprint: request.fingerprint, image }));
    while (this.entries.size > this.maximumEntries) {
      const evicted = this.entries.keys().next().value as string | undefined;
      if (evicted === undefined) break;
      this.entries.delete(evicted);
      this.rememberGeneration(evicted, (this.generations.get(evicted) ?? 0) + 1);
    }
    for (const listener of this.listeners) listener(request.roomId);
    return true;
  }

  get(roomId: string, fingerprint: string): RasterImageSnapshotV1 | undefined {
    this.assertKey(roomId, fingerprint);
    if (this.disposed) return undefined;
    const retained = this.entries.get(roomId);
    if (retained?.fingerprint !== fingerprint) return undefined;
    this.entries.delete(roomId);
    this.entries.set(roomId, retained);
    return retained.image;
  }

  invalidate(roomId: string): void {
    if (this.disposed || roomId === '') return;
    this.entries.delete(roomId);
    this.rememberGeneration(roomId, (this.generations.get(roomId) ?? 0) + 1);
    for (const listener of this.listeners) listener(roomId);
  }

  subscribe(listener: (roomId: string) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.entries.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const roomId of this.generations.keys()) {
      this.generations.set(roomId, (this.generations.get(roomId) ?? 0) + 1);
    }
    this.entries.clear();
    this.listeners.clear();
  }

  private assertKey(roomId: string, fingerprint: string): void {
    if (
      roomId.trim() === '' || fingerprint.trim() === ''
      || roomId.length > 512 || fingerprint.length > 16_384
    ) {
      throw new Error('Sidebar image cache key is invalid.');
    }
  }

  private rememberGeneration(roomId: string, generation: number): void {
    this.generations.delete(roomId);
    this.generations.set(roomId, generation);
    while (this.generations.size > this.maximumEntries * 2) {
      const oldest = this.generations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.generations.delete(oldest);
    }
  }
}

export async function pngBlobSnapshot(blob: Blob, width: number, height: number): Promise<RasterImageSnapshotV1> {
  if (blob.type !== 'image/png') throw new Error('OneWorks capture did not return PNG.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return cloneSnapshot({
    $schema: CHATROOM_SIDEBAR_IMAGE_SCHEMA,
    contract: CHATROOM_SIDEBAR_IMAGE_CONTRACT,
    schemaVersion: 1,
    mediaType: 'image/png',
    encoding: 'base64',
    data: globalThis.btoa(binary),
    width,
    height,
  });
}

function snapshotBlob(snapshot: RasterImageSnapshotV1): Blob {
  const binary = globalThis.atob(snapshot.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

/** Compose completed captures and release every decoded bitmap on all paths. */
export async function composeChatroomSidebarSnapshots(
  snapshots: readonly RasterImageSnapshotV1[],
  total: number,
): Promise<RasterImageSnapshotV1> {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas rendering is unavailable.');
  const results = await Promise.allSettled(snapshots.map(snapshot => createImageBitmap(snapshotBlob(snapshot))));
  const images = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  try {
    const failure = results.find(result => result.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
    const placements = total === 1
      ? [{ x: 4, y: 4, size: 120 }]
      : total === 2
      ? [{ x: 2, y: 25, size: 78 }, { x: 48, y: 25, size: 78 }]
      : total === 3
      ? [{ x: 25, y: 2, size: 78 }, { x: 2, y: 48, size: 78 }, { x: 48, y: 48, size: 78 }]
      : [{ x: 2, y: 2, size: 78 }, { x: 48, y: 2, size: 78 }, { x: 2, y: 48, size: 78 }];
    images.forEach((image, index) => {
      const placement = placements[index]!;
      context.save();
      context.beginPath();
      context.arc(
        placement.x + placement.size / 2,
        placement.y + placement.size / 2,
        placement.size / 2 - 2,
        0,
        Math.PI * 2,
      );
      context.clip();
      context.drawImage(image, placement.x, placement.y, placement.size, placement.size);
      context.restore();
      context.beginPath();
      context.arc(
        placement.x + placement.size / 2,
        placement.y + placement.size / 2,
        placement.size / 2 - 1,
        0,
        Math.PI * 2,
      );
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(255,255,255,.9)';
      context.stroke();
    });
    if (total >= 4) {
      context.beginPath();
      context.arc(87, 87, 38, 0, Math.PI * 2);
      context.fillStyle = '#30343b';
      context.fill();
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(255,255,255,.9)';
      context.stroke();
      context.fillStyle = '#fff';
      context.font = '700 28px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(`+${total - 3}`, 87, 88, 64);
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(value => {
        if (value === null) reject(new Error('Canvas PNG encoding failed.'));
        else resolve(value);
      }, 'image/png')
    );
    return await pngBlobSnapshot(blob, 128, 128);
  } finally {
    for (const image of images) image.close();
  }
}
