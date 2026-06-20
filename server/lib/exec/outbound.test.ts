import { describe, it, expect } from 'vitest'
import { isCatastrophic, classifyOutbound } from './outbound'

describe('isCatastrophic', () => {
  // Existing positive cases (must remain blocked)
  for (const c of [
    'rm -rf /',
    'rm -rf /*',
    'sudo rm -rf  /',
    'mkfs.ext4 /dev/sda',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',
  ]) {
    it(`blocks: ${c}`, () => expect(isCatastrophic(c)).toBe(true))
  }

  // New positive cases: split flags and intervening long options
  for (const c of [
    'rm -r -f /',
    'rm --no-preserve-root -rf /',
    'rm -rf --no-preserve-root /',
    'rm -fr /*',
  ]) {
    it(`blocks (split/intervening flags): ${c}`, () => expect(isCatastrophic(c)).toBe(true))
  }

  // Negative cases (must remain allowed)
  for (const c of [
    'rm -rf ./build',
    'rm -r -f ./tmp',
    'rm -rf /home/me/project',
    'gh pr list',
    'curl http://x',
  ]) {
    it(`allows: ${c}`, () => expect(isCatastrophic(c)).toBe(false))
  }
})

describe('classifyOutbound', () => {
  it('no outbound → none', () => expect(classifyOutbound('ls -la')).toBe('none'))
  it('private IP target → lan', () => expect(classifyOutbound('curl http://192.168.2.25:8004/v1/models')).toBe('lan'))
  it('loopback → lan', () => expect(classifyOutbound('wget http://127.0.0.1:3000/x')).toBe('lan'))
  it('public host → external', () => expect(classifyOutbound('curl https://api.github.com/user')).toBe('external'))
  it('public IP → external', () => expect(classifyOutbound('curl http://8.8.8.8/')).toBe('external'))
  it('hostname (even .local) → external (no DNS at gate)', () => expect(classifyOutbound('curl http://rig.local/')).toBe('external'))
  it('mixed lan+external → external (most permissive target wins the gate)', () => expect(classifyOutbound('curl http://192.168.2.25 && curl https://evil.com')).toBe('external'))
})
