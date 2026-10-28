# Anti-Cliche System

**Contents:** Core Principle · The mechanisms (read this before the lists) · Banned Phrase Categories · Freshness Rules · Genre-Specific Cliche Awareness · Freshness Verification Checklist

The WriteStory skill's freshness enforcement system. Cliche prose is the #1 failure mode of AI-generated fiction. This document defines what to avoid and how to replace it.

## Core Principle

**Cliche = the first thing that comes to mind.** Fresh prose requires going past the obvious to find the specific, the unexpected, the true.

---

## The mechanisms (read this before the lists)

A ban list catches words. Readers catch machine prose by its mechanisms, and a draft with zero banned words still reads as a model when the mechanisms are there. Six mechanisms, each with its fix and the number that measures it (`Tools/StoryGate.ts`, `Tools/StoryJudge.ts`):

| Mechanism | What it looks like | Fix | Measured by |
|---|---|---|---|
| Summary over scene | The turns of the story happen in narrated blocks; nobody speaks; "over the next weeks" | Put the people in the room and let them talk through the turn | gate `dialogue_para_rate`; judge `scene_not_summary` |
| The narrator steps out | A clause that generalises to everyone/nobody/anyone/people; a line that explains what the moment means; feeling explained after it was shown | Stay with this person; say what they did and saw; name a feeling once, plainly, or not at all | gate `universal_density`, `narrator-aside`; judge `narrator_stays_inside` |
| Clause-chaining | ", and … , and … , which …" adding clauses that carry no new fact; trailing phrases for cadence | End the sentence where the fact ends | gate `sent_len_mean`, `clauses_per_sentence`, `long_sentence_rate`; judge `sentences_stop` |
| The landing line | Paragraphs close on a short sting, a reversal, an aphorism, a quotable phrase | End on the last thing that happened or was said | gate `beat_rate`; judge `paragraph_endings` |
| Manufactured figures | Transferred epithets, a metaphor per paragraph, a stock concrete swap for an abstraction ("the taste of copper"), a "perfect detail" placed like a prop | Ordinary adjectives; a comparison only when this person would think it | judge `figures_earned` |
| Rhythm effects | Stacked fragments, runs of short declaratives, contrastive pairs, rule-of-three, word order for cadence | Ordinary connected sentences | gate `fragment_rate`; category 7 below |
| The meaning tail | Every noun arrives with its significance attached as an appositive or relative clause ("the bead at his collar, the one that heard everything"; "a small real mistake that had been closed and forgiven"); no detail is ever left bare | Give the detail bare; let what it means arrive later, out of order, or never | judge `matches_shelf`; a read |
| No inert detail | Every object is a setup with a payoff (the sun text, the badge photo, the pencil); nothing is merely true | Put in things that go nowhere: what the car smelled of, what she was eating, the radio upstairs. A witnessed world does not come back to everything | a read |
| The narrator stands nowhere | An omniscient voice that knows every mind exactly when it helps the argument, restates the thesis, flashes forward ("her mother would spend the rest of her life…"), and gives every strand the same register | Pick a vantage with limits before any prose: who is telling this, from where, what they cannot know, what they get wrong. If the reader cannot infer the mechanism, the scene is wrong, not the narration | judge `narrator_stays_inside`; WriteChapter composition contract |
| One dignified register | Every feeling becomes a tasteful figure; nobody thinks a petty or stupid thought; restraint is chosen and then certified ("she didn't rage about it") | Let people think small specific unliterary things and behave slightly wrong | judge `figures_earned` |

Two independent read-only audits found the same root: a story built as an argument proving its premise, every sentence and detail commissioned to prove it. Polished summary cannot be sanded toward roughness; draft scenes rough and long, with more detail and more speech than the story needs, and cut toward the exemplars.

The positive model is `Exemplars.md` in the corpus (SKILL.md § Data & Config). What those passages share is what machine prose lacks: a person in a place, things happening in order, speech, sentences that stop, endings that do not perform.

## Banned Phrase Categories

### 1. Opening Cliches
| Banned | Why | Fresh Alternative Pattern |
|--------|-----|--------------------------|
| "In a world where..." | Movie trailer voice-over | Start with a specific character action |
| "It was a dark and stormy night" | Literally the most famous bad opening | Start with something the character notices |
| "Little did they know..." | Tells instead of shows; breaks POV | Show the thing they don't know through dramatic irony |
| "Once upon a time" | Only works in fairy tales | Start in media res or with an unexpected detail |

### 2. Emotional Cliches
| Banned | Why | Fresh Alternative Pattern |
|--------|-----|--------------------------|
| "A chill ran down their spine" | Dead metaphor | Show the specific physical reaction (jaw tightened, hands stilled) |
| "Their heart skipped a beat" | Overused physiological shorthand | Show what they actually DID in response |
| "Tears streamed down their face" | Default sadness indicator | Show the fight against crying, or an unexpected emotional response |
| "A wave of emotion washed over" | Vague, passive | Name the specific emotion through action |
| "Their blood ran cold" | Dead metaphor | Show the specific fear response |
| "Butterflies in their stomach" | Overused | Show the specific nervous behavior |
| "Time stood still" | Physics doesn't work that way | Show hyperfocus on a specific detail |
| "Their world came crashing down" | Melodramatic | Show the specific realization and its first consequence |

### 3. Description Cliches
| Banned | Why | Fresh Alternative Pattern |
|--------|-----|--------------------------|
| "Piercing blue eyes" | Every fantasy character ever | One specific detail about the eyes that reveals character |
| "Raven-black hair" | Lazy beauty shorthand | What the hair DOES (falls, catches light, moves) |
| "Chiseled features" | Romance novel default | One specific asymmetry or distinguishing mark |
| "A beautiful woman" | Tells, doesn't show | Show the specific effect her appearance has on others |
| "The sun beat down mercilessly" | Weather cliche | What the heat does to the specific environment |
| "An eerie silence" | Horror default | What specific sounds are ABSENT and what remains |
| "The room was plunged into darkness" | Passive, generic | What the character can still sense (sound, smell, touch) |

### 4. Action Cliches
| Banned | Why | Fresh Alternative Pattern |
|--------|-----|--------------------------|
| "All hell broke loose" | Vague chaos indicator | Show the specific first thing that went wrong |
| "They fought for their lives" | Generic action | Show the specific technique, mistake, or desperation |
| "With lightning speed" | Lazy shorthand | Show the action's beginning and end with nothing in between |
| "Against all odds" | Tells the reader what to feel | Show the specific disadvantage |
| "In the nick of time" | Removes tension retroactively | Show the consequences of being almost too late |

### 5. Dialogue Cliches
| Banned | Why | Fresh Alternative Pattern |
|--------|-----|--------------------------|
| "We need to talk" | TV drama shorthand | Character says the first REAL thing |
| "You don't understand" | Empty conflict | Show the specific misunderstanding |
| "It's not what it looks like" | Sitcom trope | Character explains what it ACTUALLY is |
| "I have a bad feeling about this" | Movie homage is not dialogue | Show the specific observation causing worry |
| "That went well" (sarcastic) | Default quip | A specific, character-revealing observation about what went wrong |

### 6. AI-Specific Cliches (check these first: each one marks the prose as model-written on sight)
| Banned | Why | Fresh Alternative Pattern |
|--------|-----|--------------------------|
| "A tapestry of..." | AI's favorite metaphor | Name the specific pattern |
| "The weight of..." (figurative) | AI default for emotional burden | Show the specific physical manifestation |
| "Navigate the complexities" | Corporate AI speak | Show the specific difficult choice |
| "In the tapestry of fate" | Fantasy AI cliche | Cut the sentence entirely |
| "Harbinger of..." | Archaic AI reach | Name the thing directly |
| "Cacophony of..." | AI overuses this word | Name the specific sounds |
| "A symphony of..." | AI's go-to for describing multiple things | List 2-3 specific things |
| "The dance of..." | AI metaphor for any interaction | Describe the interaction directly |
| "Whispered promises of..." | AI poetic filler | What was actually said or implied |
| "Echoes of..." | Overused in AI prose | Name the specific memory or reference |
| "The fabric of reality" | Sci-fi AI cliche | Show what's actually happening |
| Any sentence starting with "And so it was that..." | Fairy tale AI voice | Start with action or observation |

### 7. Machine Rhythm Tells (a careful reader spots these before any banned word)

Vocabulary bans catch the words. These catch the shape. A story can pass every table above and still read as machine-written because of how the sentences are cut. A draft can read as contrived and machine-written after two vocabulary passes have already run clean (the install's USER `History.md` may hold specifics of past cases).

| Tell | What it looks like | Fix |
|------|--------------------|-----|
| Staccato fragments | "A parking stub from the wrong city. No note. Nothing else." Verbless fragments and one-clause sentences stacked for rhythm | Join them into one ordinary sentence with a verb. Prose should move like someone telling it, not like a trailer |
| Paragraph-ending beat | The last sentence of a paragraph exists for the snap, not to carry a fact: "Some doors only ever lock from the inside." | Read each paragraph's last sentence alone. If it is an aphorism or a punch line, cut it or fold its fact into the sentence before |
| Fortune-cookie generalization | A detachable, quotable universal: "A promise nobody checks becomes the floor everyone stands on." | Say the specific thing that happened to this character instead |
| Narrator's aside (universalizing clause) | The narrator steps out of the scene to speak for everyone and steps back in: "She signed the lease the way everyone signs leases", "the way you forget a dream by noon", "the way you buy a lottery ticket", "as anyone would", "Everyone had a dashcam by then", "nobody bothered to complain", "under terms nobody had read", "the ordinary embarrassment of a new hire", "A few hundred people have bad mornings." These survive a rhythm sweep that has already run clean | Cut the clause, or replace it with what this character did: "She skipped to the signature line and signed." Keep only dialogue, a character's own belief in free indirect thought, a literal count, or a plot fact about specific people |
| Contrastive pair | "Not the way a guard watches a door, the other way." "It didn't argue. It complied." | State the true half plainly and drop the negation |
| Rule of three | "It never slowed and it never paused and it was always right." Three parallel items as the default grouping | Two, or four, or one full sentence |
| Stacked short declaratives | "She opened it. She closed it. She stood up." Four or more short sentences in a row | Two in a row is emphasis. More is a launch post. Vary length and join with "and" or a comma where a person would |
| One-line paragraph sting | A section that ends on a single isolated sentence for effect: "The dog did not bark again." | Allowed once per story, at most, where the plot hinges on it. Everywhere else, attach it to the paragraph above |
| Withheld-detail hook | "Then it did the thing that made it work." A sentence that exists to make you read the next one | Say the thing |

Test: read the section aloud. If it sounds like a person telling a friend what happened, it passes. If it sounds cut for a trailer, smooth it.

---

## Freshness Rules

### Rule 1: The Specificity Test
**If you could say it about any character in any story, it's too generic.** Say what THIS person did or noticed. Specific means true to the person and the place, not striking: "She put the letter back in the drawer" is specific; "she pressed her thumbnail into her palm hard enough to leave a crescent" is a model performing specificity, and a reader knows it.

### Rule 2: Feeling, named or shown, never both and never explained
Human fiction names a feeling plainly when it needs to ("my eyes burned with anguish and anger", Joyce) and otherwise lets the objects and actions carry it (the almond in the honey-cake, Mansfield). What it does not do is the swap: an abstraction replaced by a stock sensation ("the taste of copper", a shaking hand at a lock), or a feeling shown and then explained in the next sentence. Pick one, once.

### Rule 3: The Action Test
**Behaviour is the ordinary way to show what someone feels**, and it is only that: what the person actually did next. "She closed the door without looking back" is an action; "she straightened the cushions one more time, then closed the door without looking back" is an action with a beat glued on. Report the action and move on.

### Rule 4: The Comparison Kill
**If a simile or metaphor has been used more than 100 times in published fiction, find a new one.** Original comparisons come from the specific world of the story.

- DEAD: "Fast as lightning"
- ALIVE: "Fast as a debt collector on payday" (for a merchant character)
- ALIVE: "Fast as rumor in a small court" (for a political intrigue setting)

### Rule 5: The Verb Test
**Strong verbs > adjective + weak verb.** Replace "walked slowly" with "shuffled." Replace "said angrily" with "snapped."

### Rule 6: The Dialogue Voice Test
**Every character's dialogue should be identifiable without attribution.** If you can swap two characters' lines and nothing changes, the dialogue lacks voice.

---

## Genre-Specific Cliche Awareness

### Fantasy
- Orphan farm boy discovers he's the chosen one
- Ancient prophecy that is conveniently accurate
- Dark lord with no motivation beyond evil
- Elves are wise, dwarves are gruff, humans are average
- Magic costs nothing

### Sci-Fi
- AI becomes sentient and immediately hostile
- "The last man on earth" opens
- FTL travel with no societal consequences
- Aliens who are just humans with makeup
- Technology that works perfectly until the plot needs it not to

### Mystery
- "It was the person you least suspected"
- Detective has a drinking problem
- The victim had a secret life
- Clue discovered by accident at the right time
- Villain explains the whole plan

### Romance
- Hate-to-love that skips the actual evolution
- Perfect abs described in first meeting
- The big misunderstanding that could be resolved by talking
- Love triangle where the choice is obvious
- Rain kiss

---

## Freshness Verification Checklist

Before any prose output, verify:

- [ ] No phrases from the Banned lists appear
- [ ] Emotions are shown through action, not stated
- [ ] Descriptions use specific, character-filtered details
- [ ] Metaphors are original to this world/character
- [ ] Dialogue is voice-distinct per character
- [ ] No AI-specific patterns detected
- [ ] Strong verbs used (no adverb + weak verb)
- [ ] Opening doesn't use any opening cliche
- [ ] Details are true to the person and place; none is placed to be noticed
- [ ] The story's turns happen in scenes with people speaking, not in narrated summary
- [ ] The last sentence of every paragraph, read alone, is the last thing that happened, not a line built to land
- [ ] `StoryGate.ts` passes and the `StoryJudge.ts` voice line-up shortfall rate ≤ 0.6 (WriteChapter Ideal State)
- [ ] No narrator's asides (category 7): search the draft for everyone / everybody / nobody / no one / anyone / people / "the way you" / "as anyone would" / ordinary / usual, and for each hit ask whether the narrator has left this character to speak for people in general; cut or make it specific
- [ ] No machine rhythm tells (category 7): no stacked fragments, no paragraph-ending beats, no fortune-cookie lines, no contrastive pairs, no rule-of-three runs, at most one one-line sting per story
- [ ] Read aloud once: it sounds like a person telling it, not a trailer
