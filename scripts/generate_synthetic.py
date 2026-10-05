"""Synthetic future outreach events (clearly labelled source='synthetic').
Used ONLY to demo 'new evidence arrives' after the real history is replayed.
Rates are hand-set, loosely informed by the real data, and include one deliberate
'overfit trap' (a single lucky reply from a generic hello@ inbox at an enterprise)."""
import json, random
from datetime import date, timedelta
random.seed(42)
profiles = [
 # (market, stage, segment, inbox_type, pattern, n, p_reply, p_bounce, p_positive_given_reply)
 ('IN','startup','ai_product','named_person','first',8,0.30,0.00,0.6),
 ('IN','scaleup','b2b_saas','careers_inbox','role',6,0.17,0.00,0.3),
 ('IN','agency_services','services','careers_inbox','role',6,0.00,0.17,0.0),
 ('DE','scaleup','b2b_saas','ats_then_named_recruiter','first.last',6,0.33,0.00,0.5),
 ('NL','startup','b2b_saas','named_person','first.last',4,0.25,0.00,0.5),
 ('UK','startup','ai_product','named_person','first',5,0.00,0.40,0.0),   # guessed founder emails keep bouncing / silence
 ('global_remote','startup','product','careers_inbox','role',5,0.20,0.00,0.5),
 ('US','enterprise','product','generic_inbox','role',4,0.00,0.00,0.0),
]
names = {'ai_product':['Voxly','Agentia','Promptloop','Tracebit','Cortexa','Lumen AI','Dialstack','Mintlayer'],
         'b2b_saas':['Ledgerly','Shipfold','Rostrum','Quillworks','Brightdesk','Tallyhq','Fernway','Opsgrid','Kanbo','Northpoint'],
         'services':['Codexa Labs','Pixelforge','Bytecraft','Nimbus Tech','Orbitsoft','Devhaven'],
         'product':['Wayfarer','Helio','Parcelio','Stackline','Gridfox','Brewly','Huddle']}
ev=[]; d0=date(2026,10,6); i=0
for (mk,st,sg,it,pt,n,pr,pb,pp) in profiles:
    for k in range(n):
        i+=1
        sent=d0+timedelta(days=random.randint(0,30))
        r=random.random()
        if r<pb: out,days='bounce',0
        elif r<pb+pr: out='reply_positive' if random.random()<pp else 'reply_rejection'; days=random.randint(1,6)
        else: out,days='no_reply',None
        co=random.choice(names[sg])+f" ({mk})"
        ev.append(dict(id=f"syn-{i:03d}",sent_at=sent.isoformat(),company=co,domain=co.split()[0].lower()+'.example',
          market=mk,company_stage=st,segment=sg,inbox_type=it,address_pattern=pt,
          recipient='<person>@'+co.split()[0].lower()+'.example' if 'named' in it else 'careers@'+co.split()[0].lower()+'.example',
          subject='Synthetic outreach event',outcome=out,
          outcome_at=(sent+timedelta(days=days)).isoformat() if days is not None else None,
          days_to_outcome=days,responder=None if out in('no_reply','bounce') else 'named_recruiter',
          source='synthetic',attrs_inferred=False,duplicate_of_earlier=False))
# the deliberate overfit trap
ev.append(dict(id="syn-trap",sent_at="2026-10-20",company="Megacorp (US)",domain="megacorp.example",market="US",
  company_stage="enterprise",segment="product",inbox_type="generic_inbox",address_pattern="role",recipient="hello@megacorp.example",
  subject="Synthetic outreach event",outcome="reply_positive",outcome_at="2026-10-21",days_to_outcome=1,responder="named_recruiter",
  source="synthetic",attrs_inferred=False,duplicate_of_earlier=False,
  note="Deliberate trap: one lucky reply. A good Skeptic should block a rule like 'prefer hello@ at enterprises' (n=1)."))
ev.sort(key=lambda e:e['sent_at'])
json.dump(ev,open("data/evidence.synthetic.json","w"),indent=1)
from collections import Counter; print(len(ev),Counter(e['outcome'] for e in ev))
