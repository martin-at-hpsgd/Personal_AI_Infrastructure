# Create Story Explanation

A narrative story explanation (opening, body, closing) of a source, in the user's voice.

## Ideal State

- The narrative opens with one 15-25-word sentence that names the source with a plain descriptor (interview, paper, talk, article, post) and no journalistic adjectives, carries a body of 5-15 sentences that escalates from background through main points and examples to implications in conversational 9th-grade English with varied sentence length, and closes with one 15-25-word sentence that lands why it matters without hyperbole.
- Every sentence stays inside what the source says; nothing is extrapolated beyond it.
- The delivered output is only the narrative, as markdown: line breaks between sentences, a period at the end of each sentence, and just the flowing narrative from first sentence to last.

## Anti-criteria

- No section headers, no analysis notes, no commentary around the narrative.
- No bullet markers, and no labels like "Opening:", "Body:", "Closing:".

## Output format

The shape below is the one `Patterns/create_story_explanation/system.md` produces when applied to the extracted content; `Tools/CheckFormat.ts --format create` checks it:
- **Opening** (15-25 words) - plain descriptor, no journalistic adjectives
- **Body** (5-15 sentences) - escalating story flow, 9th-grade English, varied sentence length
- **Closing** (15-25 words) - "wow" factor without hyperbole
