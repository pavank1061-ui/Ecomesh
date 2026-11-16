import test from 'node:test';
import assert from 'node:assert/strict';
import factory from 'ggwave';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { float32SamplesToGgwaveBytes, ggwaveBytesToFloat32 } from '../ggwave-audio.js';
import { legacyPacketSigningFields, packetSigningFields } from '../packet-signing.js';

const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};

test('bundled ggwave encodes and decodes a local modem payload', async t => {
  const ggwave = await factory();
  const instance = ggwave.init(ggwave.getDefaultParameters());
  t.after(() => ggwave.free(instance));
  const payload = JSON.stringify({ protocol: 1, type: 'private', body: 'ciphertext-test' });
  const waveform = ggwave.encode(instance, payload, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10);
  assert.ok(waveform instanceof Int8Array);
  assert.ok(waveform.length > 0);
  const decoded = ggwave.decode(instance, waveform);
  assert.equal(new TextDecoder().decode(decoded), payload);
});

test('packet signatures verify with mutable hop count and accept queued legacy packets', async () => {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const packet = {
    protocol: 1, type: 'private', id: 'A'.repeat(32), source: 'B'.repeat(16), destination: 'C'.repeat(16),
    created: 1, expires: 2, priority: 'normal', category: 'General', hopLimit: 4, hopCount: 0,
    envelope: { salt: 'salt', iv: 'iv', ciphertext: 'ciphertext' },
  };
  const bytes = value => new TextEncoder().encode(canonical(value));
  const currentSignature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, bytes(packetSigningFields(packet)));
  const forwarded = { ...packet, hopCount: 1, signature: currentSignature };
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.publicKey, currentSignature, bytes(packetSigningFields(forwarded))), true);

  const legacySignature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, bytes(legacyPacketSigningFields(packet)));
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.publicKey, legacySignature, bytes(packetSigningFields(packet))), false);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.publicKey, legacySignature, bytes(legacyPacketSigningFields(packet))), true);
});

test('a newly queued private packet passes destination signature and decryption checks', async () => {
  const subtle = webcrypto.subtle;
  const agreementA = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const agreementB = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const signingA = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const agreementAPublic = await subtle.exportKey('jwk', agreementA.publicKey);
  const agreementBPublic = await subtle.exportKey('jwk', agreementB.publicKey);
  const signingAPublic = await subtle.exportKey('jwk', signingA.publicKey);
  const created = Date.now();
  const meta = {
    protocol: 1, id: 'A'.repeat(32), source: 'B'.repeat(16), destination: 'C'.repeat(16),
    created, expires: created + 86400000, priority: 'normal', category: 'General',
  };
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const derive = async (privateKey, publicJwk) => {
    const publicKey = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('EchoMesh private message v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  };
  const plaintext = 'This test checks the same encrypted packet fields used by EchoMesh.';
  const senderKey = await derive(agreementA.privateKey, agreementBPublic);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(JSON.stringify(meta)), tagLength: 128 }, senderKey, new TextEncoder().encode(plaintext)));
  const base64url = bytes => Buffer.from(bytes).toString('base64url');
  const packet = {
    ...meta, type: 'private', hopLimit: 4, hopCount: 0,
    envelope: { salt: base64url(salt), iv: base64url(iv), ciphertext: base64url(ciphertext) },
  };
  packet.signature = base64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingA.privateKey, new TextEncoder().encode(canonical(packetSigningFields(packet)))));
  const verifyKey = await subtle.importKey('jwk', signingAPublic, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, Buffer.from(packet.signature, 'base64url'), new TextEncoder().encode(canonical(packetSigningFields(packet)))), true);
  const receiverKey = await derive(agreementB.privateKey, agreementAPublic);
  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(JSON.stringify(meta)), tagLength: 128 }, receiverKey, ciphertext);
  assert.equal(new TextDecoder().decode(decrypted), plaintext);
});

test('Float32 speaker output round-trips through microphone-sized ggwave chunks', async t => {
  const ggwave = await factory();
  const parameters = ggwave.getDefaultParameters();
  parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  const instance = ggwave.init(parameters);
  t.after(() => ggwave.free(instance));
  const payload = 'EchoMesh chunked speaker-microphone regression';
  const waveform = ggwave.encode(instance, payload, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 25);
  const speakerSamples = ggwaveBytesToFloat32(waveform);
  assert.ok(speakerSamples.length < waveform.length);
  let decoded = '';
  for (let offset = 0; offset < speakerSamples.length; offset += 1024) {
    const chunk = speakerSamples.subarray(offset, Math.min(offset + 1024, speakerSamples.length));
    const result = ggwave.decode(instance, float32SamplesToGgwaveBytes(chunk));
    if (result?.length) decoded = new TextDecoder().decode(result);
  }
  assert.equal(decoded, payload);
});

test('fragmented private packet survives acoustic chunking and reassembles byte-for-byte', async t => {
  const ggwave = await factory();
  const makeInstance = () => {
    const parameters = ggwave.getDefaultParameters();
    parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    return ggwave.init(parameters);
  };
  const tx = makeInstance();
  const rx = makeInstance();
  t.after(() => { ggwave.free(tx); ggwave.free(rx); });

  const packetText = JSON.stringify({
    protocol: 1, type: 'private', source: 'A'.repeat(16), destination: 'B'.repeat(16),
    id: 'C'.repeat(32), created: Date.now(), expires: Date.now() + 86400000,
    priority: 'normal', category: 'General', hopLimit: 4, hopCount: 0,
    envelope: { salt: 'S'.repeat(22), iv: 'I'.repeat(16), ciphertext: 'C'.repeat(1200) },
    signature: 'X'.repeat(86),
  });
  const payload = Buffer.from(packetText, 'utf8').toString('base64url');
  const transferId = 'D'.repeat(32);
  const frameCount = Math.ceil(payload.length / 64);
  const frames = Array.from({ length: frameCount }, (_, i) => JSON.stringify({
    v: 1, k: 1, id: transferId, i, n: frameCount, d: payload.slice(i * 64, (i + 1) * 64),
  }));
  const received = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const waveform = ggwave.encode(tx, frames[frameIndex], ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 25);
    const samples = ggwaveBytesToFloat32(waveform);
    for (let offset = 0; offset < samples.length; offset += 1024) {
      const chunk = samples.subarray(offset, Math.min(offset + 1024, samples.length));
      const result = ggwave.decode(rx, float32SamplesToGgwaveBytes(chunk));
      if (result?.length) received.push(new TextDecoder().decode(result));
    }
    if (frameIndex + 1 < frames.length) {
      const gap = new Float32Array(12 * 1024);
      ggwave.decode(rx, float32SamplesToGgwaveBytes(gap));
    }
  }
  assert.deepEqual(received, frames);
  const assembled = Buffer.from(received.map(frame => JSON.parse(frame).d).join(), 'base64url').toString('utf8');
  assert.equal(assembled, packetText);
});

test('browser vendor bundle exposes its factory and its embedded WASM works offline', async () => {
  const context = vm.createContext({
    window: {},
    document: { currentScript: { src: 'http://localhost/vendor/ggwave.js' } },
    console, TextDecoder, TextEncoder, atob, btoa, performance, setTimeout, clearTimeout, WebAssembly, fetch,
  });
  const source = await readFile(new URL('../vendor/ggwave.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  const ggwave = await context.ggwave_factory();
  const instance = ggwave.init(ggwave.getDefaultParameters());
  const payload = 'EchoMesh browser bundle local self-test';
  const waveform = ggwave.encode(instance, payload, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10);
  assert.equal(new TextDecoder().decode(ggwave.decode(instance, waveform)), payload);
});

test('largest EchoMesh acoustic fragment fits the modem payload and round-trips', async t => {
  const ggwave = await factory();
  const instance = ggwave.init(ggwave.getDefaultParameters());
  t.after(() => ggwave.free(instance));
  const frame = JSON.stringify({ v: 1, k: 1, id: 'A'.repeat(32), i: 63, n: 64, d: 'B'.repeat(64) });
  assert.ok(new TextEncoder().encode(frame).length <= 140);
  const waveform = ggwave.encode(instance, frame, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10);
  const decoded = ggwave.decode(instance, waveform);
  assert.equal(new TextDecoder().decode(decoded), frame);
});
