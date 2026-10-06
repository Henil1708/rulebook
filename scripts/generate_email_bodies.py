"""Synthetic email bodies, one per sent email in data/evidence.*.json (clearly labelled: email-bodies.synthetic.json).
Used ONLY until the real bodies exist in data/email-bodies.local.json (gitignored, never pushed).

The bodies vary the way real cold outreach does (greeting by recipient, opening, length, skills matched to the
subject's role, follow-up wording for re-sends), but carry NO hidden signal: the outcome of an email is never
used to choose its text. Anything the app "learns" from these is noise, which is why the UI labels them samples.
Placeholders match the anonymised data: <candidate>, <company>, <person>, <link: ...>."""
import json, random
from datetime import date

random.seed(7)

rows = json.load(open("data/evidence.real.json")) + json.load(open("data/evidence.synthetic.json"))

GREETING = {
    "named_person": ["Hi <person>,", "Hello <person>,", "Dear <person>,"],
    "founders_alias": ["Hi <person>,", "Hello founders,"],
    "careers_inbox": ["Hi <company> team,", "Dear Hiring Team,", "Hello,", "Hi team,"],
    "hr_inbox": ["Dear HR Team,", "Hello HR team,", "Hi,"],
    "generic_inbox": ["Hello,", "Hi there,", "Dear <company> team,"],
    "ats_then_named_recruiter": ["Hi <person>,", "Hello <person>,"],
    "inbound_recruiter": ["Hi <person>,"],
    "ats_portal": ["Dear Hiring Team,"],
}

# Skills lines picked by keywords in the subject, so each body fits the role it was sent for.
SKILLS = [
    (("ai", "agent", "llm"), [
        "Over the last year I've built LLM-backed features end to end: agent workflows, retrieval over product data, and the evaluation harness around them.",
        "Recently most of my work has been applied AI: tool-using agents in Node and Python, prompt and eval pipelines, and the product UI around them.",
    ]),
    (("frontend", "react", "typescript"), [
        "On the frontend I work mostly in React and TypeScript, with a focus on fast, accessible interfaces and solid component libraries.",
        "I've led frontend work in React/TypeScript, from design-system components to performance work on large dashboards.",
    ]),
    (("java",), [
        "Alongside React I've shipped Java/Spring services, so I'm comfortable owning a feature from the API to the UI.",
    ]),
    (("mern", "node"), [
        "Most of my experience is on the MERN stack: Node and Express services, MongoDB, and React front ends.",
    ]),
]
GENERAL = [
    "I'm a full-stack engineer with 5.5 years of experience across Node, Python and React, mostly in product teams that ship weekly.",
    "I have 5.5 years of full-stack experience (Node.js, Python, React) and have led small teams through launches.",
    "I've spent the last 5+ years building web products end to end, from database design to the UI, mostly in startups.",
]
OPENING = [
    "I'm writing about the {role} role.",
    "I came across the {role} opening and wanted to reach out directly.",
    "I'd like to be considered for the {role} position.",
    "I saw that <company> is hiring for {role}, and I think my background is a close fit.",
    "",
]
ASK = [
    "I've attached my resume. Would you be open to a short call this week or next?",
    "My resume is attached. I'd be glad to share more about my recent projects if it's useful.",
    "Please find my resume attached. Happy to go through anything in more detail.",
    "I've attached my CV and would appreciate it if you could pass it to the hiring manager.",
]
SIGN = [
    "Best regards,\n<candidate>\n<link: portfolio> | <link: LinkedIn>",
    "Thanks,\n<candidate>\n<link: LinkedIn>",
    "Best,\n<candidate>\n<link: GitHub> | <link: portfolio>",
    "Kind regards,\n<candidate>",
]
FOLLOW_UP = [
    "I'm following up on my earlier email about the {role} role, in case it got buried. I'm still very interested.",
    "Just bumping this up: I wrote a few weeks ago about the {role} role and would love to hear if there's a fit.",
    "Following up on my application for the {role} role. Happy to share anything else that helps.",
]


def role_of(subject: str) -> str:
    """The job title in a subject, or a neutral phrase when the subject isn't one (follow-ups, "Resume for…")."""
    low = subject.lower()
    if not subject or any(w in low for w in ("follow", "resume for", "synthetic", "portal")):
        return "Senior Full-Stack Engineer"
    s = subject.replace("Application for ", "").split(" - ")[0]
    s = s.replace(" application", "").replace("(remote track)", "(remote)").strip()
    return s if 3 < len(s) < 70 else "Senior Full-Stack Engineer"


def body(r: dict) -> str:
    subject = r.get("subject") or ""
    role = role_of(subject)
    greet = random.choice(GREETING.get(r["inbox_type"], ["Hello,"]))
    if r.get("duplicate_of_earlier") or "follow-up" in subject.lower():
        lines = [greet, "", random.choice(FOLLOW_UP).format(role=role), "", random.choice(ASK), "", random.choice(SIGN)]
        return "\n".join(lines)
    low = subject.lower()
    skills = [random.choice(opts) for keys, opts in SKILLS if any(k in low for k in keys)]
    paras = [random.choice(OPENING).format(role=role), random.choice(GENERAL), *skills[:2]]
    if random.random() < 0.4:  # some emails are short
        paras = paras[:2]
    text = " ".join(p for p in paras if p)
    return "\n".join([greet, "", text, "", random.choice(ASK), "", random.choice(SIGN)])


out = {r["id"]: body(r) for r in rows if r.get("sent_at") and r["inbox_type"] != "ats_portal" and r["outcome"] != "inbound_contact"}
json.dump(out, open("data/email-bodies.synthetic.json", "w"), indent=2, ensure_ascii=False)
print(f"wrote {len(out)} bodies to data/email-bodies.synthetic.json ({date.today()})")
