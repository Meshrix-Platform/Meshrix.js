export const RELEASE_JOURNEY_VISUAL_CAPTURE: Readonly<Record<string, any>> = Object.freeze({
  viewport: Object.freeze({ width: 1440, height: 1000 }),
  deviceScaleFactor: 2,
  pixelWidth: 2880,
  pixelHeight: 2000
});

const PNG_SIGNATURE_HEX: any = "89504e470d0a1a0a";

export function readPngDimensions(sourceBytes?: any) : any {
  const bytes: any = Buffer.isBuffer(sourceBytes)
    ? sourceBytes
    : sourceBytes instanceof Uint8Array
      ? Buffer.from(sourceBytes)
      : null;
  if (
    bytes === null
    || bytes.byteLength < 24
    || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }
  const width: any = bytes.readUInt32BE(16);
  const height: any = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return Object.freeze({ width, height });
}
