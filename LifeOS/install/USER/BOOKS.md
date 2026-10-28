---
title: Favorite Books
classification: public
review_cadence: 180d
last_updated: 1970-01-01
version: 1.0.0
provenance: template
---

# Favorite Books

No books captured yet. This file is the public favorites list: the Pulse books page, the daemon site and `LIFEOS/TOOLS/BooksSync.ts` all read it, so keep only books you are happy to publish.

Add one block per book under a `##` category heading. Each block starts with a line `- title: "Book Name"`, followed by indented lines for `author:`, `year:`, `rating:` (1 to 10), `themes:` (a bracketed list such as `[meaning, craft]`) and `canonical: true` for the ones you would reread for life. Only the title is required.

To fill it from your Cortex notes instead of by hand, run `bun LIFEOS/TOOLS/BooksSync.ts --check` for a preview and `bun LIFEOS/TOOLS/BooksSync.ts --apply` to write. It maintains a generated block at the bottom and never touches the sections you wrote.
