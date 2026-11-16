/** Fields covered by the source signature; hopCount is mutable while forwarding. */
export function packetSigningFields(packet) {
  const unsigned = { ...packet };
  delete unsigned.signature;
  delete unsigned.hopCount;
  return unsigned;
}

/** Verify packets already queued by older EchoMesh builds, which signed hopCount=0. */
export function legacyPacketSigningFields(packet) {
  const unsigned = { ...packet };
  delete unsigned.signature;
  return unsigned;
}
