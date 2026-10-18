import { test, expect } from 'bun:test';
import worker from './index.js';
import { handleVerify } from './verify.js';
import { handleAdmin } from './admin.js';
import { handleIntake } from './handler.js';
import { handleCheckSubmit, handleCheckRecent, handleCheckResult, handleCheckRetry, handleCheckRecheck } from './check.js';

const origins = ['https://qiuyuanqr.github.io', 'https://search.qiuyuan.net'];
function env(throws = false) {
  return { ALLOWED_ORIGIN: origins[0], ALLOWED_ORIGINS: origins.join(','),
    CHECK_KEY: 'KEY', ADMIN_KEY: 'ADMIN',
    INTAKE_KV: { async get(k) { if (throws) throw Error('offline'); return k === 'invite:GOOD' ? 'example@example.com' : null; }, async put() {}, async delete() {} } };
}
const paths = ['/', '/verify', '/admin/list', '/check', '/check/recent', '/check/task/result', '/check/task/retry', '/check/task/recheck'];
for (const origin of origins) {
  for (const path of paths) test(`${origin} OPTIONS ${path}`, async () => {
    const res = await worker.fetch(new Request('https://worker.test' + path, {method:'OPTIONS', headers:{Origin:origin}}), env());
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('vary').toLowerCase()).toContain('origin');
  });
  test(`${origin} successful verify and routed errors`, async () => {
    const res = await worker.fetch(new Request('https://worker.test/verify', {headers:{Origin:origin, 'x-invite-token':'GOOD'}}),env());
    expect(res.status).toBe(200); expect((await res.json()).ok).toBe(true);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    for (const [path,method,status] of [['/check','GET',405],['/check/unknown','GET',404],['/check/recent','GET',401]]) {
      const r = await worker.fetch(new Request('https://worker.test'+path,{method,headers:{Origin:origin}}),env());
      expect(r.status).toBe(status); expect(r.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const failure = await worker.fetch(new Request('https://worker.test/verify?k=GOOD',{headers:{Origin:origin}}),env(true));
    expect(failure.status).toBe(500); expect(failure.headers.get('access-control-allow-origin')).toBe(origin);
  });
}
for (const origin of ['https://search.qiuyuan.net.evil.test', 'https://evil.test', 'null', 'http://search.qiuyuan.net']) {
  test(`untrusted Origin is not reflected: ${origin}`, async () => {
    const res = await worker.fetch(new Request('https://worker.test/verify',{method:'OPTIONS',headers:{Origin:origin}}), env());
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
}
test('direct handlers share the same origin decision', async () => {
  for (const [path,fn] of [['/',handleIntake],['/verify',handleVerify],['/admin/list',handleAdmin],['/check',handleCheckSubmit],['/check/recent',handleCheckRecent],['/check/task/result',handleCheckResult],['/check/task/retry',handleCheckRetry],['/check/task/recheck',handleCheckRecheck]]) {
    const r=await fn(new Request('https://worker.test'+path,{method:'OPTIONS',headers:{Origin:origins[1]}}),env(),'task',{now:()=>new Date().toISOString()});
    expect(r.headers.get('access-control-allow-origin')).toBe(origins[1]);
  }
});
test('legacy ALLOWED_ORIGIN and server requests remain compatible',async()=>{
  const e=env();delete e.ALLOWED_ORIGINS;
  const r=await handleVerify(new Request('https://worker.test/verify'),e);
  expect(r.headers.get('access-control-allow-origin')).toBe(origins[0]);
});
