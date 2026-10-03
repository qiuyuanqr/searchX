"""Validate a complete structured model reply, then materialize host-owned paths."""
import re
from bridge import Bridge


def schema(kind):
    if kind=='factcheck':props={'result_md':{'type':'string'},'image_code':{'type':'string'}}
    elif kind=='research':
        props={k:{'type':'string'} for k in ['report_html','notes_md','sources_md']}
        props['evidence']={'type':'array','items':{'type':'object','properties':{'name':{'type':'string'},'content':{'type':'string'}},'required':['name','content'],'additionalProperties':False}}
    else:raise ValueError('Unknown bundle kind')
    return {'type':'object','properties':props,'required':list(props),'additionalProperties':False}


def materialize(data,root,kind):
    fields=schema(kind)['properties']
    if not isinstance(data,dict) or set(data)!=set(fields):raise ValueError('Incomplete or unexpected bundle fields')
    bridge=Bridge({'root':str(root),'writable':True})
    names={'report_html':'report.html','notes_md':'notes.md','sources_md':'sources.md','result_md':'result.md'}
    pending={}
    for key in fields:
        if key=='evidence':continue
        value=data[key]
        if not isinstance(value,str) or (key!='image_code' and not value.strip()):raise ValueError('Missing artifact text')
        if len(value.encode())>2_000_000:raise ValueError('Oversized artifact')
        if key in names:pending[names[key]]=value
    if 'report_html' in data and not re.search(r'<!doctype html>|<html\b',data['report_html'],re.I):raise ValueError('Missing HTML document')
    if not isinstance(data.get('evidence',[]),list):raise ValueError('Invalid evidence list')
    for item in data.get('evidence',[]):
        if not isinstance(item,dict) or set(item)!={'name','content'}:raise ValueError('Invalid evidence entry')
        path='data/'+item['name'] if isinstance(item['name'],str) else ''
        bridge.path(path,write=True)
        if path in pending:raise ValueError('Duplicate evidence path')
        if not isinstance(item['content'],str) or len(item['content'].encode())>2_000_000:raise ValueError('Invalid evidence text')
        pending[path]=item['content']
    # Preflight every path before writing even one file. Disk failure remains a failed job.
    for name in pending:
        target=bridge.path(name,write=True)
        if target.exists() and not target.is_file():raise ValueError('Artifact path is not a file')
    for name,content in pending.items():bridge.call('write_file',{'path':name,'content':content})
    return sorted(pending)
