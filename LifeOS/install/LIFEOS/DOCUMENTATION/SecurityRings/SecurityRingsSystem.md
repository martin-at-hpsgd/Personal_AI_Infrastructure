---
version: 1.0.1
---

# Security Rings

Security Rings decides how much of LifeOS a person or a conversation can reach. There are four rings. Each ring holds its members and one policy, and a conversation takes the ring of its least-trusted member.

| Ring | Who is in it | What it gets |
|---|---|---|
| 0 | The principal, on their own channels (the terminal, their locked text thread, their phone line) | The whole system, under the Permission Boundaries table in the system prompt |
| 1 | The inner circle: people the principal trusts, who still never reach Ring 0's tools or data | Chat, a short list of skills run on our side by a confined runner, and a message passed to the principal |
| 2 | People the principal knows who are not inner circle | A plain acknowledgement and their message passed to the principal |
| 3 | Everyone and everything else | Nothing acts for them; their words are dropped or passed on only as quoted data |

## How it works

**Rings hold their members.** Nothing carries a ring field. Each ring file lists its members by People record id, so every phone number and email a person has lands in the same ring, and one file shows everyone in a ring. Anything listed in no ring is Ring 3. One person listed in two rings fails validation.

**A conversation takes the highest ring present.** A group of Ring 1 people is Ring 1. Add one Ring 2 member and the whole conversation is Ring 2. The principal in a Ring 1 group is Ring 1, because a group never inherits the principal's authority. The ring is recomputed every turn from the live membership, and a membership that cannot be read makes the conversation Ring 3.

**Each ring has one policy.** The sections are members, answers, skills, data in reach, actions, model lane, caps and logging. Anything a ring's file does not list is refused.

**`answers` is what members can ask about.** `answers.can` lists, in plain sentences, what a ring's members can ask about and get answered; `answers.never` lists what they never get, however they ask. A channel that answers a ring builds its rules from these two lists at every reply, so changing what your inner circle can ask is an edit to one file. The lists shape how the model answers. The hard guarantee is that the model answering a lower ring has none of your data in reach, so it has nothing to give away even if it is talked round.

**It fails closed.** A ring file that is missing, malformed, or lists someone twice makes the engine refuse, and callers treat a refusal as Ring 3 for everyone.

## Why limits, not detectors

Security Rings follows Bitter Lesson Engineering. A smarter model changes neither who may authorize what nor what a process can reach, so those are enforced in code: a lower ring's runner starts with only its ring's skills, no access to the principal's files or credentials, and no subscription billing. Detecting prompt injection by its wording is the opposite kind of control: it bets on how attackers phrase things, and better models make it less needed. Injection checks in Security Rings only measure (an eval each release); they never sit in a message path.

Ring 0's protection against outside words follows the same rule. Every consequential action, including any send to someone other than the principal, passes one point that asks the principal first.

## Files

| Path | What it holds | Ships |
|---|---|---|
| `LIFEOS/RINGS/policy.ts` | The engine: load, validate, resolve a handle, a conversation's ring | ✅ |
| `LIFEOS/RINGS/Rings.ts` | The CLI | ✅ |
| `LIFEOS/RINGS/templates/ring-<n>.yaml` | Empty ring files with every section | ✅ |
| `LIFEOS/USER/SECURITY/RINGS/ring-<n>.yaml` | Your rings: members and policy | ❌ USER data |

`LIFEOS_RINGS_DIR` points the engine at another directory, which tests use.

## Commands

```bash
bun LIFEOS/RINGS/Rings.ts validate          # all four rings present, every section, no person twice
bun LIFEOS/RINGS/Rings.ts list              # each ring's members, pending names and skills
bun LIFEOS/RINGS/Rings.ts resolve <handle>  # the ring a phone or email belongs to
bun LIFEOS/RINGS/Rings.ts conversation <handle>...
bun LIFEOS/RINGS/Rings.ts relay [--apply]   # compare the texting bridge's allowlists with the rings
```

The CLI prints names and counts, never a phone number or email.

## Setting up

1. Copy `LIFEOS/RINGS/templates/*.yaml` to `LIFEOS/USER/SECURITY/RINGS/`.
2. Find your People record id with `people who <your name> --json`, and put it under Ring 0's members.
3. Add your inner circle to Ring 1 the same way. Someone you have named but cannot match yet goes under `pending`, which resolves nothing.
4. Run `Rings.ts validate`.

## The texting bridge

Relay answers Ring 1, in a direct text or a group, with a persona built from Ring 1's `answers`, read fresh at each reply. A group is answered under Ring 1 whoever is in it, the principal included, and a group with anyone outside Rings 0 and 1 is not answered. Every text row on the record carries its ring.

Relay keeps two allowlists: the principal's numbers and chat-only contacts. `Rings.ts relay` compares them with Rings 0 and 1. With `--apply` it rewrites the chat-only list from Ring 1. It never writes the principal's list, which is pinned by a root-owned file only the principal changes; it reports whether that list and the pin agree with Ring 0.
