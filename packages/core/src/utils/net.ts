// server/utils/net.ts
export function isPrivateAddress(ip: string | undefined | null): boolean {
  if (!ip) return false
  let addr: string = ip.trim()
  if (addr === '::1') return true
  // strip IPv4-mapped IPv6 prefix
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) addr = mapped[1]!
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127) return true // loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  return false
}
