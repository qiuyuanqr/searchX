import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('static publisher integration and fault tests (Python stdlib)',()=>{
  const dir=fileURLToPath(new URL('.',import.meta.url));
  const r=spawnSync('python3',['-m','unittest','discover','-s',dir,'-p','test_*.py'],{encoding:'utf8',timeout:30000});
  if(r.status!==0)throw new Error((r.stdout||'')+(r.stderr||''));
  expect(r.status).toBe(0);
});
