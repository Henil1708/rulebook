# Evidence data

Two files. Never mix them up in the UI. Every row carries `source`.

| File | Rows | `source` | What it is |
|---|---|---|---|
| `evidence.real.json` | 142 | `gmail` | My real job outreach, Jun–Oct 2026, exported from my Gmail and anonymised |
| `evidence.synthetic.json` | 45 | `synthetic` | Made-up future events (Oct–Nov 2026), used only to demo "new evidence arrives". Includes one deliberate trap row (`syn-trap`) |

## Anonymisation
- **Company names and domains are pseudonyms** (`ValeWillow`, `valewillow.example`). The real names are not in this repo.
- **Personal email addresses are removed.** A named person becomes `<person>@<pseudo>.example`. Role inboxes (`careers@`, `hr@`…) keep their local part because the *type* of inbox is the signal.
- **Subjects keep the job title.** Brand names are replaced with `<company>` and my name with `<candidate>`.
- **No email bodies are stored.**

## Schema (one row = one outreach attempt, or one inbound event)
| Field | Meaning |
|---|---|
| `id` | `ev-###` (real) or `syn-###` (synthetic) |
| `sent_at` | Date the email was sent (null for one ATS application whose date is unknown) |
| `company`, `domain` | Pseudonyms |
| `market` | `IN`, `UK`, `DE`, `NL`, `SE`, `US`, `global_remote`, … |
| `company_stage` | `startup` · `scaleup` · `enterprise` · `agency_services` |
| `segment` | `ai_product` · `b2b_saas` · `product` · `services` · `ai_services` |
| `inbox_type` | `careers_inbox` · `hr_inbox` · `generic_inbox` (info@/contact@/hello@) · `named_person` · `founders_alias` · `ats_portal` · `inbound_recruiter` |
| `address_pattern` | `role` · `first` · `first.last` · `other` (how a personal address was built) |
| `outcome` | `no_reply` · `bounce` · `auto_ack` · `reply_rejection` · `reply_redirect` ("apply on the portal") · `reply_positive` · `inbound_contact` · `pending` |
| `outcome_at`, `days_to_outcome` | When the outcome arrived |
| `responder` | `named_recruiter` · `named_founder` · `role_inbox` · `auto_responder` · `mailer_daemon` |
| `duplicate_of_earlier` | true if I had already emailed this exact address before |
| `attrs_inferred` | true: market/stage/segment were labelled by hand from public knowledge, not from the email |
| `note` | Free text for a few special rows |

## What the real data says (my own baseline)
137 dated sends (excluding 3 pending and 2 special rows), 11 human replies (8%), 11 bounces.

| Slice | Sent | Human replies | Bounces |
|---|---|---|---|
| Personal address **guessed** at a **foreign** company | 34 | **0** | 4 |
| Agency / IT-services companies | 46 | 1 (2%) | 5 |
| Enterprises (2000+ staff) | 17 | 0 | 0 |
| AI-product companies | 19 | 4 (21%) | 0 |
| Scale-ups | 37 | 6 (16%) | 6 |
| Re-sent to an address I'd already emailed | 30 | 3 (10%) | 3 |

Other facts:
- **89 emails went out on a single day (12 Jul).**
- The only positive outcomes came from a **named person at a small AI-product company**, plus one **follow-up on a thread that had already gone warm**.
- One agency never answered three cold emails, but its recruiter later **reached out to me herself** (`ev-137`).

**Caveat:** every slice is small. The Skeptic agent exists to say so. Any rule built on fewer than ~10 sends in a slice is a hypothesis, not a lesson.

## How it was built
1. Searched Gmail for sent mail with a PDF résumé attached, from 2026-06-15 onward.
2. Reading each thread gave the outcome: a mailer-daemon reply means a bounce, a no-reply auto-responder means `auto_ack`, and a human reply was classified by hand.
3. Company attributes were labelled by hand.
4. Exact duplicates (same address, same day, same subject) were removed.
5. Everything was pseudonymised.

The raw export never leaves my machine. `scripts/generate_synthetic.py` regenerates the synthetic file (seeded, so it's deterministic).
