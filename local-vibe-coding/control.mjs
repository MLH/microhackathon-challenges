#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

const [action, url, token] = process.argv.slice(2);
if (!['status', 'stop', 'read-state', 'write-state'].includes(action) || !url || (action !== 'read-state' && !token)) process.exit(2);

try {
  if (action === 'read-state') {
    const fd = openSync(url, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== 65) throw new Error('invalid state');
      const value = readFileSync(fd, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid token');
      process.stdout.write(value);
    } finally { closeSync(fd); }
  } else if (action === 'write-state') {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid token');
    const temporary = `${url}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, `${token}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, url);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else if (action === 'status') {
    const nonce = randomBytes(16).toString('hex');
    const expected = Buffer.from(createHmac('sha256', token).update(nonce).digest('hex'));
    const response = await fetch(`${url}/__status`, {
      headers: { 'x-local-vibe-nonce': nonce }, signal: AbortSignal.timeout(500),
    });
    const proof = Buffer.from(response.headers.get('x-local-vibe-proof') ?? '');
    process.exitCode = response.status === 204 && proof.length === expected.length && timingSafeEqual(proof, expected) ? 0 : 1;
  } else {
    const response = await fetch(`${url}/__stop`, {
      method: 'POST', headers: { 'x-local-vibe-token': token }, signal: AbortSignal.timeout(1000),
    });
    process.exitCode = response.status === 204 ? 0 : 1;
  }
} catch {
  process.exitCode = 1;
}
