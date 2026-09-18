/**
 * 生成更接近真实日志的混合语料：含大量半结构化文本、偶发堆栈、
 * 时间戳、数字、随机 id 等，压缩率不会极端。
 */
export function realisticLogs(total: number, seed0 = 20260917): Uint8Array {
  const enc = new TextEncoder();
  const templates: ((s: number) => string)[] = [
    (s) => `2026-09-17T10:${String(s % 60).padStart(2, '0')}:${String((s * 7) % 60).padStart(2, '0')}Z INFO request id=${(s % 9000) + 1000} path=/api/v2/orders/${s % 500} status=200 dur=${s % 800}ms`,
    (s) => `2026-09-17T10:${String(s % 60).padStart(2, '0')}:${String((s * 3) % 60).padStart(2, '0')}Z WARN slow query table=orders took=${500 + (s % 2000)}ms rows=${s % 300}`,
    (s) => `2026-09-17T10:${String(s % 60).padStart(2, '0')}:${String((s * 5) % 60).padStart(2, '0')}Z ERROR connection refused host=db-${s % 16}.internal port=5432 retry=${s % 5}`,
    (s) => `2026-09-17T10:${String(s % 60).padStart(2, '0')}:${String((s * 11) % 60).padStart(2, '0')}Z DEBUG cache ${s % 2 ? 'hit' : 'miss'} key=req:${(s * 2654435761) >>> 0} ttl=${30 + (s % 300)}s`,
    (s) => `2026-09-17T10:${String(s % 60).padStart(2, '0')}:${String((s * 13) % 60).padStart(2, '0')}Z INFO user=${['alice', 'bob', 'carol', 'dave'][s % 4]} action=login ip=10.${s % 256}.${(s >> 4) % 256}.${(s >> 8) % 256}`,
    (s) => `    at Handler.process (/srv/app/handler.js:${100 + (s % 400)}:${s % 80})`,
    (s) => `    at Router.dispatch (/srv/app/router.js:${40 + (s % 60)}:${s % 20})`,
    (s) => `2026-09-17T10:${String(s % 60).padStart(2, '0')}:${String((s * 17) % 60).padStart(2, '0')}Z INFO bytes_in=${s * 13 % 9000} bytes_out=${s * 29 % 90000} gzip=${s % 3 === 0}`,
  ];
  const out = new Uint8Array(total);
  let s = seed0;
  let p = 0;
  while (p < total) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const line = templates[s % templates.length](s) + '\n';
    const b = enc.encode(line);
    const n = Math.min(b.length, total - p);
    out.set(b.subarray(0, n), p);
    p += n;
  }
  return out;
}
