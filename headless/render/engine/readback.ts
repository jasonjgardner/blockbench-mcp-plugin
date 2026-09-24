/**
 * Removes the per-row padding WebGPU adds so rows align to 256 bytes. three.js trims the padding
 * from the last row, so the stride comes from the alignment rule, not from `byteLength / height`.
 */
export function packRows(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4;
  const stride = Math.ceil(rowBytes / 256) * 256;
  if (stride === rowBytes) return bytes.subarray(0, rowBytes * height);
  const packed = new Uint8Array(rowBytes * height);
  Array.from({ length: height }, (_, y) => packed.set(bytes.subarray(y * stride, y * stride + rowBytes), y * rowBytes));
  return packed;
}
