import dgram from 'dgram';
import net from 'net';

export interface OltConn {
  host?: string;
  snmpPort?: number;
  snmpCommunity?: string;
  /** Extra TCP ports to try for reachability (telnet/ssh/http). */
  ports?: number[];
}

export interface OltProbeResult {
  online: boolean;
  sysName: string | null;
  sysDescr: string | null;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  uptimeTicks: number | null;
  probedPort: number | null;
  error?: string;
}

function tcpConnect(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** Encode ASN.1 OID numbers into BER bytes. */
function encodeOid(oid: string): Buffer {
  const parts = oid.replace(/^\./, '').split('.').map((n) => parseInt(n, 10));
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 128) {
      out.push(v);
    } else {
      const stack: number[] = [];
      stack.push(v & 0x7f);
      v >>= 7;
      while (v > 0) {
        stack.push(0x80 | (v & 0x7f));
        v >>= 7;
      }
      for (let j = stack.length - 1; j >= 0; j--) out.push(stack[j]);
    }
  }
  return Buffer.from(out);
}

function berLen(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function berSeq(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), berLen(body.length), body]);
}

function buildSnmpGet(community: string, oid: string, requestId: number): Buffer {
  const oidBytes = encodeOid(oid);
  const oidTlv = Buffer.concat([Buffer.from([0x06]), berLen(oidBytes.length), oidBytes]);
  const nullTlv = Buffer.from([0x05, 0x00]);
  const varbind = berSeq(0x30, oidTlv, nullTlv);
  const varbindList = berSeq(0x30, varbind);
  const reqId = Buffer.concat([Buffer.from([0x02, 0x04]), Buffer.from([(requestId >>> 24) & 0xff, (requestId >>> 16) & 0xff, (requestId >>> 8) & 0xff, requestId & 0xff])]);
  const errorStatus = Buffer.from([0x02, 0x01, 0x00]);
  const errorIndex = Buffer.from([0x02, 0x01, 0x00]);
  const pdu = berSeq(0xa0, reqId, errorStatus, errorIndex, varbindList);
  const version = Buffer.from([0x02, 0x01, 0x01]); // SNMPv2c
  const commBuf = Buffer.from(community, 'utf8');
  const communityTlv = Buffer.concat([Buffer.from([0x04]), berLen(commBuf.length), commBuf]);
  return berSeq(0x30, version, communityTlv, pdu);
}

function decodeSnmpString(buf: Buffer): string | null {
  // Walk for OctetString (0x04) or OID (0x06) after first few TLVs — simplistic extract of last string value.
  let i = 0;
  let lastStr: string | null = null;
  let lastInt: number | null = null;
  while (i < buf.length - 2) {
    const tag = buf[i++];
    let len = buf[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | buf[i++];
    }
    if (i + len > buf.length) break;
    const slice = buf.subarray(i, i + len);
    if (tag === 0x04) {
      lastStr = slice.toString('utf8').replace(/\0/g, '').trim();
    } else if (tag === 0x02 || tag === 0x43) {
      // INTEGER or TimeTicks
      let v = 0;
      for (let k = 0; k < slice.length; k++) v = (v << 8) | slice[k];
      lastInt = v;
    } else if (tag === 0x30 || tag === 0xa2) {
      // recurse into sequence / response PDU by continuing scan
    }
    i += len;
    if (tag === 0x02 && lastInt != null && lastStr == null) {
      /* keep scanning */
    }
  }
  if (lastStr) return lastStr;
  if (lastInt != null) return String(lastInt);
  return null;
}

function snmpGet(host: string, community: string, oid: string, port = 161, timeoutMs = 2500): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const done = (val: string | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(val);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const pkt = buildSnmpGet(community || 'public', oid, (Date.now() & 0xffffffff) >>> 0);
    socket.on('message', (msg) => {
      clearTimeout(timer);
      done(decodeSnmpString(msg));
    });
    socket.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    socket.send(pkt, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        done(null);
      }
    });
  });
}

function inferVendor(descr: string | null): string | null {
  if (!descr) return null;
  const d = descr.toLowerCase();
  if (d.includes('huawei')) return 'Huawei';
  if (d.includes('zte') || d.includes('zxan') || d.includes('c300') || d.includes('c600')) return 'ZTE';
  if (d.includes('fiberhome') || d.includes('an5516')) return 'FiberHome';
  if (d.includes('vsol') || d.includes('v1600')) return 'VSOL';
  if (d.includes('cdata') || d.includes('fd1')) return 'C-Data';
  if (d.includes('mikrotik')) return 'MikroTik';
  if (d.includes('cisco')) return 'Cisco';
  return null;
}

function inferModel(descr: string | null): string | null {
  if (!descr) return null;
  // Common patterns: "Huawei MA5800-X15 ..." / "ZTE C300 ..."
  const m =
    descr.match(/\b(MA\d{4}[-\w]*)\b/i) ||
    descr.match(/\b(C[36]00[-\w]*)\b/i) ||
    descr.match(/\b(AN\d{4}[-\w]*)\b/i) ||
    descr.match(/\b(V1600[-\w]*)\b/i) ||
    descr.match(/\b(FD\d{3,4}[-\w]*)\b/i);
  return m ? m[1] : descr.slice(0, 80);
}

/**
 * Probe an OLT by IP: TCP reachability on common management ports,
 * then SNMPv2c sysDescr / sysName / sysUpTime when community is set.
 */
export async function probeOlt(conn: OltConn): Promise<OltProbeResult> {
  const host = String(conn.host || '').trim();
  if (!host) {
    return {
      online: false,
      sysName: null,
      sysDescr: null,
      vendor: null,
      model: null,
      firmware: null,
      uptimeTicks: null,
      probedPort: null,
      error: 'IP address / host is required.',
    };
  }

  const snmpPort = conn.snmpPort || 161;
  const community = conn.snmpCommunity || 'public';
  const tryPorts = conn.ports?.length
    ? conn.ports
    : [snmpPort, 23, 22, 80, 443, 8080];

  let probedPort: number | null = null;
  for (const p of tryPorts) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await tcpConnect(host, p);
    if (ok) {
      probedPort = p;
      break;
    }
  }

  // SNMP can succeed even when TCP-to-161 is filtered differently; always try.
  const [sysDescr, sysName, uptimeRaw] = await Promise.all([
    snmpGet(host, community, '1.3.6.1.2.1.1.1.0', snmpPort),
    snmpGet(host, community, '1.3.6.1.2.1.1.5.0', snmpPort),
    snmpGet(host, community, '1.3.6.1.2.1.1.3.0', snmpPort),
  ]);

  const snmpOk = !!(sysDescr || sysName);
  const online = snmpOk || probedPort != null;
  if (!online) {
    return {
      online: false,
      sysName: null,
      sysDescr: null,
      vendor: null,
      model: null,
      firmware: null,
      uptimeTicks: null,
      probedPort: null,
      error: `Host ${host} unreachable (tried TCP ${tryPorts.join(', ')} and SNMP ${snmpPort}).`,
    };
  }

  const vendor = inferVendor(sysDescr);
  const model = inferModel(sysDescr);
  const uptimeTicks = uptimeRaw != null && /^\d+$/.test(uptimeRaw) ? Number(uptimeRaw) : null;

  return {
    online: true,
    sysName: sysName || null,
    sysDescr: sysDescr || null,
    vendor,
    model,
    firmware: sysDescr ? sysDescr.slice(0, 120) : null,
    uptimeTicks,
    probedPort: snmpOk ? snmpPort : probedPort,
  };
}
