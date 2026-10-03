"""Bounded task MCP. No shell, arbitrary SQL, publication, mail, or private queries."""
import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import uuid
from zoneinfo import ZoneInfo

ARTIFACTS = {'report.html', 'notes.md', 'sources.md', 'result.md'}
QUERIES = ('company_snapshot','financials_recent','valuation_brief','quote_brief',
           'concepts_of','zt_history','recent_news','industry_peers','upcoming_events',
           'lookup_stock','broker_view','ah_view','funds_chips_view','hotspot_context')


class Bridge:
    def __init__(self, config):
        self.config = config
        self.root = Path(config['root']).resolve(strict=True)
        self.writable = config.get('writable') is True

    def path(self, name, *, write=False):
        if not isinstance(name, str) or not name or '\\' in name:
            raise ValueError('Invalid task path')
        parts = name.split('/')
        if PurePosixPath(name).is_absolute() or any(p in ('', '.', '..') or p.startswith('.') for p in parts):
            raise ValueError('Task path traversal denied')
        # Host namespaces attachments and copied evidence under inputs/. The
        # traversal/symlink checks still apply to every component; inputs stay readonly.
        allowed = (name in ARTIFACTS or (parts[0]=='inputs' and len(parts)>=2)
                   or (parts[0]=='data' and len(parts)==2))
        if not allowed: raise ValueError('File outside task allowlist')
        if write:
            if not self.writable or parts[0]=='inputs': raise ValueError('Read-only file')
            if parts[0]=='data' and not re.fullmatch(r'web-[a-zA-Z0-9_-]+\.(json|md|txt)',parts[1]):
                raise ValueError('Raw Stocks evidence cannot be replaced')
        path = self.root
        for part in parts:
            path = path/part
            if path.is_symlink(): raise ValueError('Symlinks denied')
        if not path.resolve().is_relative_to(self.root): raise ValueError('Path escaped task root')
        return path

    def tools(self):
        def tool(name,description,properties,required,read=True):
            return {'name':name,'description':description,'annotations':{'readOnlyHint':read,'destructiveHint':False},
                    'inputSchema':{'type':'object','properties':properties,'required':required,'additionalProperties':False}}
        result=[tool('read_file','Read task inputs or generated artifact; relative paths only.',{'path':{'type':'string'}},['path']),
                tool('list_files','List available task files.',{},[])]
        if self.config.get('stocks_python') and self.config.get('stocks_query_script'):
            result.append(tool('stocks_query','Read public market data only; research scope and user=none fixed. Raw results and query provenance (.meta.json) auto-archived; check provenance before reusing snapshots.',{'function':{'type':'string','enum':list(QUERIES)},'arguments':{}},['function']))
        if self.config.get('images'):
            result.append(tool('read_image','Read only the approved synthetic/task images.',{'path':{'type':'string','enum':self.config['images']}},['path']))
        return result

    def query(self, args):
        name=args.get('function')
        if name not in QUERIES or set(args)-{'function','arguments'}: raise ValueError('Query not allowed')
        def has_user(value):
            if isinstance(value,dict):return any(k in ('user_id','account_id','scope','module') or has_user(v) for k,v in value.items())
            if isinstance(value,list):return any(has_user(v) for v in value)
            return False
        if has_user(args.get('arguments')): raise ValueError('Private query denied')
        if not self.config.get('stocks_python') or not self.config.get('stocks_query_script'): raise ValueError('Stocks queries not configured')
        from runtime import child_env
        env=child_env(os.environ)
        env.update(STOCKS_DB_QUERY_ONLY='1',STOCKS_AGENT_USER_ID='none')
        cmd=[self.config['stocks_python'],self.config['stocks_query_script'],'research',name]
        if 'arguments' in args:
            value=args['arguments'];cmd.append(value if isinstance(value,str) else json.dumps(value,ensure_ascii=False))
        proc=subprocess.run(cmd,cwd=self.root,env=env,capture_output=True,text=True,timeout=110)
        if proc.returncode:raise ValueError(f'Stocks query {name} failed (exit={proc.returncode}); no data accepted')
        data=json.loads(proc.stdout)
        # Host audit caching is independent of the model's read-only tool permissions.
        # Every return gets an exclusive file; repeated live queries must never erase history.
        folder=self.root/'data'
        if folder.is_symlink():raise ValueError('Evidence symlink denied')
        folder.mkdir(exist_ok=True)
        stamp=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:12]
        target=folder/f'stocks-db-{name}-{stamp}-{uuid.uuid4().hex}.json'
        with target.open('x',encoding='utf-8') as stream:stream.write(proc.stdout)
        provenance={'query':args,'scope':'research','user':'none','raw_file':target.name,
                    'retrieved_at':datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
                    'sha256':hashlib.sha256(proc.stdout.encode('utf-8')).hexdigest()}
        with target.with_suffix('.meta.json').open('x',encoding='utf-8') as stream:
            json.dump(provenance,stream,ensure_ascii=False,indent=2)
        return data

    def call(self,name,args):
        if not isinstance(args,dict):raise ValueError('Arguments must be an object')
        if name=='stocks_query':return self.query(args)
        if name=='list_files':
            return sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')
                          if p.is_file() and not p.is_symlink() and not any(x.startswith('.') for x in p.relative_to(self.root).parts))
        if name=='read_file':return self.path(args.get('path')).read_text(encoding='utf-8')
        if name=='write_file':
            path=self.path(args.get('path'),write=True)
            content=args.get('content')
            if not isinstance(content,str) or len(content.encode())>2_000_000:raise ValueError('Invalid or oversized content')
            path.parent.mkdir(exist_ok=True)
            path.write_text(content,encoding='utf-8')
            return {'written':args['path'],'bytes':len(content.encode())}
        if name=='read_image':
            if args.get('path') not in self.config.get('images',[]):raise ValueError('Image not approved')
            raw=self.path(args['path']).read_bytes()
            if len(raw)>10_000_000:raise ValueError('Image too large')
            if raw.startswith(b'\x89PNG\r\n\x1a\n'):mime='image/png'
            elif raw.startswith(b'\xff\xd8\xff'):mime='image/jpeg'
            elif len(raw)>=12 and raw[:4]==b'RIFF' and raw[8:12]==b'WEBP':mime='image/webp'
            else:raise ValueError('Only PNG/JPEG/WebP images allowed')
            return [{'type':'image','data':base64.b64encode(raw).decode(),'mimeType':mime}]
        raise ValueError('Unknown task tool')

    def dispatch(self,request):
        method=request.get('method')
        if method=='initialize':return {'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'searchx','version':'0.1'}}
        if method=='ping':return {}
        if method=='tools/list':return {'tools':self.tools()}
        if method=='tools/call':
            params=request.get('params') or {}
            try:
                if params.get('name') not in [t['name'] for t in self.tools()]:raise ValueError('Tool not exposed to model')
                result=self.call(params.get('name'),params.get('arguments') or {})
                blocks=result if params.get('name')=='read_image' else [{'type':'text','text':result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)}]
                return {'content':blocks,'isError':False}
            except (ValueError,OSError,subprocess.SubprocessError) as exc:
                return {'content':[{'type':'text','text':str(exc)}],'isError':True}
        raise ValueError('Unsupported MCP method')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True)
    bridge=Bridge(json.loads(Path(parser.parse_args().config).read_text()))
    for line in sys.stdin:
        try:request=json.loads(line)
        except ValueError:continue
        if not isinstance(request,dict) or 'id' not in request:continue
        response={'jsonrpc':'2.0','id':request['id']}
        try:response['result']=bridge.dispatch(request)
        except Exception as exc:response['error']={'code':-32602,'message':str(exc)}
        print(json.dumps(response,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
