#!/usr/bin/env python3
"""Exercise history/filter/cursor/timeline over a real Compose restart."""
import datetime as dt
import http.cookies
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid

phase, origin, state_file = sys.argv[1:]
state = {} if phase == 'seed' else json.load(open(state_file, encoding='utf-8'))

def request(method, path, body=None, bearer=None):
    headers = {'Content-Type': 'application/json'}
    if bearer:
        headers['Authorization'] = f'Bearer {bearer}'
    elif state.get('cookies'):
        headers['Cookie'] = state['cookies']
        headers['Origin'] = origin
        headers['X-CSRF-Token'] = state['csrf']
    req = urllib.request.Request(origin+path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as response:
        result = json.load(response)
        if path.endswith('/auth/login'):
            cookies = http.cookies.SimpleCookie()
            for value in response.headers.get_all('Set-Cookie', []): cookies.load(value)
            state['cookies'] = '; '.join(f'{key}={value.value}' for key,value in cookies.items())
            state['csrf'] = result['csrf_token']
        return result

def pages(path, params):
    items, seen_cursors = [], set()
    while True:
        page = request('GET', path+'?'+urllib.parse.urlencode(params))
        items.extend(page['items'])
        cursor = page.get('next_cursor')
        if not cursor: return items
        assert cursor not in seen_cursors, 'repeated cursor'
        seen_cursors.add(cursor)
        params['cursor'] = cursor

if phase == 'seed':
    request('POST','/api/v1/auth/login',{'username':os.environ['HF_USERNAME'],'password':os.environ['HF_PASSWORD']})
    config = {
        'template_id':'medium-http', 'level':'medium',
        'services':[{'id':'web','name':'History','protocol':'http','port':8080,'banner':'lab'}],
        'visible_texts':{'title':'Lab','login_prompt':'Login','success':'OK','failure':'Denied'},
        'synthetic_credentials':[{'username':'reader','password':'synthetic-only'}],
        'fake_fs':[{'path':'report.txt','content':'lab'}],
        'logging':{'categories':['http.request','auth.attempt','session.started','file.listed','file.read','file.downloaded','command.received','session.ended']},
        'channel':{'tls_required':True,'heartbeat_seconds':10,'sync_seconds':2},
    }
    profile = request('POST','/api/v1/profiles',{'name':'History restart','config':config})['profile']['id']
    trap = request('POST','/api/v1/traps',{'name':'History restart','deployment_bindings':[{'service_id':'web','host_port':19080}]})['id']
    request('PUT',f'/api/v1/traps/{trap}/profile',{'profile_id':profile,'revision':1})
    token = request('POST',f'/api/v1/traps/{trap}/enrollment-token',{})['token']
    enrolled = request('POST','/agent/v1/enroll',{'trap_id':trap,'token':token})
    session = str(uuid.uuid4())
    started = dt.datetime(2026,10,14,tzinfo=dt.timezone.utc)
    kinds = ['session.started','auth.attempt','file.read','command.received']+['http.request']*125+['session.ended']
    events = []
    for index, kind in enumerate(kinds):
        events.append({'schema_version':'1.0','event_id':str(uuid.uuid4()),'trap_id':trap,'agent_id':enrolled['agent_id'],
            'profile_id':profile,'applied_revision':1,'service_id':'web','session_id':session,
            'event_type':kind,'timestamp':(started+dt.timedelta(seconds=index)).isoformat(),
            'source_ip':'192.0.2.45','destination_port':8080,'protocol':'http','payload':{'path':'/','synthetic':True}})
    filtered = [event['event_id'] for event in events if event['event_type']=='http.request']
    for field, value in [('source_ip','192.0.2.46'),('timestamp','2026-10-16T00:00:00Z'),('session_id',str(uuid.uuid4()))]:
        event = dict(events[5], event_id=str(uuid.uuid4()))
        event[field] = value
        events.append(event)
    for offset in range(0,len(events),50):
        batch = events[offset:offset+50]
        ack = request('POST',f'/agent/v1/traps/{trap}/events',{'events':batch},enrolled['agent_token'])
        assert set(ack['accepted_ids']) == {event['event_id'] for event in batch}, 'incorrect ACK IDs'
    config['services'][0]['banner'] = 'new revision after history'
    request('PATCH',f'/api/v1/profiles/{profile}',{'base_revision':1,'name':'History v2','config':config})
    state.update(trap=trap,session=session,filtered=filtered,timeline=[e['event_id'] for e in events if e['session_id']==session])
    with os.fdopen(os.open(state_file,os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600),'w') as stream: json.dump(state,stream)

items = pages('/api/v1/events',{'limit':31,'trap_id':state['trap'],'session_id':state['session'],'source_ip':'192.0.2.45',
    'event_type':'http.request','from':'2026-10-14T00:00:00Z','to':'2026-10-15T00:00:00Z'})
assert len(items)==len(state['filtered']) and {e['event_id'] for e in items}==set(state['filtered']), 'filtered ID mismatch beyond page 100'
timeline = pages(f'/api/v1/sessions/{state["session"]}/timeline',{'limit':31})
assert len(timeline)==len(state['timeline']) and {e['event_id'] for e in timeline}==set(state['timeline']), 'timeline lost/mixed IDs'
assert all(e['applied_revision']==1 for e in timeline), 'historical revision changed'
assert [e['timestamp'] for e in timeline]==sorted(e['timestamp'] for e in timeline), 'timeline order changed'
print(f'PASS {phase}: combined filters/cursors 125 IDs and timeline 132 IDs, historical revision 1 after profile v2')
