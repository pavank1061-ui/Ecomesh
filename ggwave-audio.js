/** View ggwave's returned byte buffer as the Float32 samples it contains. */
export function ggwaveBytesToFloat32(bytes) {
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError('ggwave returned audio with an unsupported sample format.');
  }
  const aligned = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice();
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/** Pass microphone Float32 samples to ggwave without changing their binary representation. */
export function float32SamplesToGgwaveBytes(samples) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError('Microphone samples must be Float32 audio.');
  }
  return new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}
