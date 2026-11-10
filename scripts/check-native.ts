import assert from 'node:assert/strict';
import { NativeEngine } from '../src/engine.js';
const engine = new NativeEngine();
try {
  const devices = await engine.devices();
  assert.ok(devices.some(device => device.backend === 'cpu' && device.available), 'The native package must expose a usable CPU backend.');
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.version, devices }));
} finally { await engine.close(); }

