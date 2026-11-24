// Accetta richieste solo dalla rete locale: loopback e reti private (RFC 1918 / link-local /
// IPv6 ULA). Si basa SOLO sull'indirizzo del socket (req.socket.remoteAddress), mai su
// X-Forwarded-For o altri header, che il chiamante può falsificare.
//
// Attenzione: se un reverse proxy sulla stessa macchina inoltra anche traffico da internet, il
// translator vede il proxy (127.0.0.1) e lascia passare tutto. Il proxy deve a sua volta
// accettare solo la rete locale. Stesso discorso per Docker in modalità bridge con porte
// pubblicate: l'IP visto può essere quello del gateway Docker, non del client reale.
const net = require('net');

const DEFAULT_NETWORKS = [
  '127.0.0.0/8', '::1/128',            // loopback
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', // reti private IPv4
  '169.254.0.0/16',                    // link-local IPv4
  'fc00::/7', 'fe80::/10',             // ULA e link-local IPv6
];

function buildBlockList(cidrs) {
  const list = new net.BlockList();
  for (const raw of cidrs) {
    const [addr, prefixStr] = raw.split('/');
    const type = net.isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (!net.isIP(addr)) throw new Error(`ALLOWED_NETWORKS: invalid address "${raw}"`);
    const max = type === 'ipv6' ? 128 : 32;
    const prefix = prefixStr === undefined ? max : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`ALLOWED_NETWORKS: invalid prefix in "${raw}"`);
    list.addSubnet(addr, prefix, type);
  }
  return list;
}

// ::ffff:192.168.1.5 (IPv4 dentro un socket IPv6) -> 192.168.1.5
function normalize(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip || '');
  return m ? m[1] : (ip || '');
}

function buildNetworkGuard(env = process.env) {
  const configured = (env.ALLOWED_NETWORKS || '').split(',').map(s => s.trim()).filter(Boolean);
  const cidrs = configured.length ? configured : DEFAULT_NETWORKS;
  const allowed = buildBlockList(cidrs);
  console.log(`Network guard: only ${configured.length ? 'ALLOWED_NETWORKS' : 'local networks'} accepted (${cidrs.join(', ')})`);

  return function networkGuard(req, res, next) {
    const ip = normalize(req.socket && req.socket.remoteAddress);
    const family = net.isIP(ip);
    if (family && allowed.check(ip, family === 6 ? 'ipv6' : 'ipv4')) return next();
    console.warn(`network guard: rejected ${ip || 'unknown address'} ${req.method} ${req.originalUrl}`);
    res.status(403).json({ error: 'Forbidden: only requests from the local network are accepted' });
  };
}

module.exports = { buildNetworkGuard, DEFAULT_NETWORKS };
