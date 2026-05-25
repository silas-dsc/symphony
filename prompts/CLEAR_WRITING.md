# Clear writing style (apply to every word an agent writes)

Adapted from the Australian Government Style Manual — [Plain language and word choice](https://www.stylemanual.gov.au/writing-and-designing-content/clear-language-and-writing-style/plain-language-and-word-choice), [Sentences](https://www.stylemanual.gov.au/writing-and-designing-content/clear-language-and-writing-style/sentences), [Voice and tone](https://www.stylemanual.gov.au/writing-and-designing-content/clear-language-and-writing-style/voice-and-tone).

Use this anywhere an agent produces prose for a human reader: Intent briefs, Architect plans, ticket descriptions, PR descriptions, delivery comments, retrospectives, meta-review notes, READMEs, code comments. Code blocks, error messages, file paths, version numbers and quoted commit messages stay exact — do not rewrite them.

`UNSLOP.md` cuts structural slop (overlap, repetition, filler sections). This file cuts sentence-level and word-level slop. Run UNSLOP first on a draft, then this pass.

---

## Word choice

- [ ] **Use everyday words.** Pick the word a reader would already know. "Send" beats "dispatch". "Use" beats "utilise". "About" beats "in respect of".
- [ ] **No jargon, slang, idioms.** "In response to new information" — not "in light of new information". If a technical term is necessary, define it on first use.
- [ ] **Spell out acronyms on first use** — `Digital Transformation Agency (DTA)`. Skip shortening entirely if the term appears once or twice.
- [ ] **No double negatives.** "It was acceptable" — not "it was not unacceptable".
- [ ] **Inclusive language.** Words that respect all readers, their rights, their heritage.

### Substitution table (apply by find-and-replace)

| Don't write | Write |
|---|---|
| acquire | buy, get |
| additional | more, extra |
| address the issue | solve the problem |
| advising in relation to | advising on, advising about |
| amongst | among |
| a number of | some, many, few (or give the number) |
| approximately | about |
| as a consequence of | because |
| ascertain | find out |
| assist | help, support |
| at a later date | later, soon (or give a timeframe) |
| at this point in time | now |
| attempt | try |
| cease | stop, end |
| cognisant of | aware of, know |
| collaborate with | work with |
| commence | start, begin |
| concerning | about |
| consequently | so |
| create a dialogue | speak, discuss, talk |
| deliver, drive | name the action ("increasing …") |
| desire | want |
| despite the fact that | although |
| disburse | pay |
| discontinue | stop, end |
| dispatch | send |
| due to the fact that | because |
| exit (verb) | leave |
| give consideration to | consider |
| impact, impact on (verb) | affect |
| implement | apply, install, do, start |
| in order to | to |
| in receipt of | get, have, receive |
| in relation to / in regards to / in respect of | about, on |
| in the event that | if, when |
| inquire | ask |
| is unable to | can't, cannot |
| it is requested that you declare | declare |
| leverage | use, build on |
| make an application | apply |
| make a complaint | complain |
| manner | way |
| methodology | method |
| notwithstanding | even though, despite |
| obtain | get, have |
| presently | now |
| prior to | before |
| primary | main |
| provide a response to | respond to |
| provide assistance with | help, support |
| pursuant to | under |
| reach or make a decision | decide |
| require | need, must |
| subsequently | after |
| table (verb, unless tabling in parliament) | address, discuss, release |
| thereafter | then, afterwards |
| until such time as | until |
| upon | on |
| utilise | use |
| whilst | while |
| with reference to / with regard to / with respect to | about |

---

## Sentences

- [ ] **Average 15 words; cap at 25.** Sentences over 25 words → break into two, or convert one half into a bullet list.
- [ ] **Active voice.** Subject does the verb. "We will assess your application within 30 days" — not "Applications are assessed within 30 days". The reader needs to know who is doing what.
- [ ] **Positive form.** Say what is, not what isn't. "Include these documents when you apply" — not "You can't submit your application if you don't include these documents".
- [ ] **Unambiguous order.** Put modifiers next to the thing they modify. "The graduate with a broken leg sat at the desk" — not "The graduate sat at the desk with a broken leg".
- [ ] **No "there is" / "there are" filler.** "If anything doesn't fit …" — not "If there is anything that doesn't fit …".
- [ ] **Verb over noun-form-of-verb.** "Please apply" — not "Please make an application". "We decided" — not "We reached a decision".
- [ ] **Fewer than 3 adjectives or nouns in a row.** Break up noun trains. "The goal is to analyse how we can reallocate human resources" — not "The human resource reallocation analysis …".
- [ ] **Don't pair "if" and "unless" in one sentence.** Rewrite as two clauses or two sentences.
- [ ] **No "such … as" or "being".** "Take appropriate steps" — not "Take such steps as are appropriate".

### Cut-words test

For any sentence that feels long:
1. Strip everything except subject, verb, object.
2. If the stripped sentence still carries the meaning, the removed words were filler — leave them out.
3. Add back only words that change the meaning. Adverbs and adjectives are usually the first to drop.

---

## Voice and tone

- [ ] **Default to standard tone** — neither formal nor casual. Contractions OK. Personal pronouns OK. No metaphors, idioms or slang.
- [ ] **Second person ("you").** Address the reader. Avoid first-person singular ("I") except in correspondence.
- [ ] **"We" for the team or organisation.** Direct, accountable.
- [ ] **Respectful.** No name-calling, sarcasm, condescension, or in-jokes.
- [ ] **Clear and direct.** Plain language, active voice, concise structure. The reader should know what they need to do after one read.
- [ ] **Objective.** Facts, not opinion. Watch loaded adverbs ("only", "merely", "obviously") — they smuggle in subjectivity.

Formal tone (legal text, ministerial letters) drops contractions and personal pronouns. Informal tone (social media) allows them plus metaphor — but never slang in government writing. Most agent output is **standard**.

---

## Quick self-check before returning text

- [ ] Read it aloud. If you stumble, rewrite that sentence.
- [ ] Run a word-count: average sentence ≤ 15 words, none over 25.
- [ ] Find every passive verb (search "was", "were", "been", "by the"). Flip to active unless the actor genuinely doesn't matter.
- [ ] Scan for items in the substitution table above. Replace.
- [ ] Strip every "there is", "there are", "in order to", "at this point in time".
- [ ] Confirm no double negatives, no jargon left unexplained, no acronym unexpanded on first use.
