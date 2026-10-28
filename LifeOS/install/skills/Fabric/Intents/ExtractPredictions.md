# ExtractPredictions

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

Every prediction a source makes, each as one short checkable line, then a table giving each one's stated confidence, its due date and how we will know whether it came true.

Our ideal-state port of Fabric's `extract_predictions`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The output gives what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (a transcript, an article, a memo, an outlook report, a thread) means every prediction it makes, in the order it makes them. A URL or a file means the predictions of the source it points at, read in full. A bare person or organization ("Ray Kurzweil", "the IEA") means the predictions on record from them. A bare topic ("fusion power", "self-driving cars") means the notable predictions on record about it, each attributed to who made it and when. A question ("what did the author predict about rates?", "when did Kurzweil say AI would pass the Turing test?") means the predictions that answer it. "This" or "that" means the predictions made in the current conversation, the assistant's own included. A typed hint ("only the ones about housing", "just the guest's", "your own predictions on X") overrides the default read.
- The title names the source and the read that was inferred ("Predictions: A Fictional Bank's 2027 Rate Outlook", "Predictions: Ray Kurzweil on AI by 2029"), so a wrong read is visible at a glance.
- A prediction is a claim that some future state of the world will hold, made by the source, that could later turn out true or false. Every such claim in the input is listed, conditional ones with their condition kept ("if rates stay above 5%, home sales fall"). A statement about the present or past, a hope, a goal, or an opinion with no future state in it is not a prediction and is left out.
- Each bullet states one prediction in at most 16 words, in plain exact words that keep the predictor's figures, thresholds and named things. When the input carries more than one voice, the bullet opens on who made it ("Ortiz: …"). A bare topic, person or question attributes every bullet to the person or body that made it and the year it was made.
- The table has one row per bullet, in the same order, and each row's Prediction cell repeats its bullet's text.
- Confidence is the confidence the predictor gave, kept as given: a number stays a number ("70%"), and words stay their words, quoted ("'almost certain'"). When the predictor gave none, the cell says `Not stated`. It is never the extractor's own estimate.
- Date is the date by which the predictor said it would happen. A relative date is resolved against the source's own date when the input gives one ("By 2028 (within two years, said in 2026)") and kept as said otherwise ("Within two years"). When the predictor gave no date, the cell says `No date given`. A deadline is never invented.
- How to Verify names the observation that would settle the prediction for this claim: what to measure, where that number is published or seen, and the threshold or event that makes it true ("Fed target rate below 4% at any meeting through 2027, per Fed statements"). When the prediction is too vague to check, the cell says so and names what is missing ("Not checkable as stated: 'mainstream' has no measure").
- When the input makes no prediction, the output is the title and the single line `No predictions found in {the source}.`, and nothing else.
- When the input is a source, the predictions are the ones it actually makes, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs). A prediction listed for a bare topic or person is one the model knows was actually made; one it cannot attribute with confidence is left out rather than guessed.
- The whole output is valid Markdown with no bold and no italics: the title, the bulleted list, and the table.
- `bun skills/Fabric/Tools/ExtractPredictionsCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the extraction. The model takes the default read and the title states it.
- Never a confidence, date or figure the predictor did not give, and never a prediction the source does not make, attributed to it.
- Never a present fact, a past event, a plan stated as intent with no forecast in it, or a wish listed as a prediction, and never a prediction left out because it seems unlikely or the extractor disagrees with it.
- Never a generic verification ("see if it happens", "check the news", "wait and see") that names no measure, source or threshold from this prediction.
- Never `N/A`, `-`, `TBD`, `unknown` or a blank cell in place of `Not stated` or `No date given`.
- Never commentary, warnings, notes, a summary, a preamble, a persona, or any section beyond the title, the list and the table.
- Never a source read from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractpredictions — code checks on the table header, the no-predictions line and plain Markdown, plus judged checks on fidelity to stated confidence and dates, what counts as a prediction, attribution, and specific verifications.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare person, organization or topic, a question about what was predicted, or "this"/"that" for the current conversation.
- An optional hint naming which predictions to keep or whose, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExtractPredictionsCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

## Output format

Markdown: one H1 title, then the bulleted list, then the table, with nothing else. These are the limits the checker enforces:

- The title opens `# Predictions: ` and names the source and the read.
- Each bullet is one `- ` line of 3 to 16 words, unindented, and no two bullets are the same.
- The table header is exactly `| Prediction | Confidence | Date | How to Verify |`, followed by its separator row and one row per bullet in bullet order, each Prediction cell repeating its bullet.
- Confidence and Date are never empty or a placeholder; with nothing stated they read `Not stated` and `No date given`. How to Verify holds at least four words.
- No bold or italics anywhere.

```markdown
# Predictions: {the source, and the read inferred}

- {prediction, at most 16 words}
- {speaker}: {prediction, at most 16 words}

| Prediction | Confidence | Date | How to Verify |
|---|---|---|---|
| {prediction, as in its bullet} | {as given, or Not stated} | {as given, or No date given} | {the measure, where it is published, and the threshold} |
| {speaker}: {prediction} | Not stated | No date given | {…} |
```

With no prediction in the input:

```markdown
# Predictions: {the source}

No predictions found in {the source}.
```

## References

- Upstream: `Patterns/extract_predictions/system.md` (a "think step-by-step" preamble, four fields per prediction, a bulleted list of 16-word predictions, and a table with Prediction, Confidence, Date and How to Verify columns, all of which this intent keeps).
- `Tools/ExtractPredictionsCheck.help.md`: the checker's rules and exit codes.
