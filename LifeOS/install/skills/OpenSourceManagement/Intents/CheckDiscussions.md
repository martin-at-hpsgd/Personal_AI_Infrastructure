# CheckDiscussions

**Contents:** Ideal State · Anti-criteria · Safety gates · Inputs · Tool contract · Output format

A discussions report across the principal's open source repos (Config.md `OSS_REPOS`), from a live GitHub Discussions fetch, with priorities, sentiment, themes and suggested replies.

## Ideal State

- The report covers the discussions of the requested repo, or every repo in Config.md `OSS_REPOS` when none was named, from this session's live GraphQL fetch, in the Output format below.
- A section that came back `ok: false` (gh failed, GraphQL returned `"errors"`, or a null `repository`, for example Discussions disabled on that repo), or a fetch that printed an `ERROR:` line, is named as a hole ("could not fetch (gh auth/scope)"); a list with `truncated: true` says "showing the 30 most recently updated".
- Each discussion carries a category and a High/Medium/Low priority from the tables in Output format, with unanswered Q&A prioritized because those are people actively seeking help.
- Each project carries a sentiment read: Community Health (active, growing, declining), Tone (supportive, frustrated, curious, appreciative) and Engagement Quality (thoughtful discussion vs. drive-by questions).
- Trending themes across discussions are named: common pain points or confusion, frequently requested features, misconceptions about the project, community energy around specific topics.
- Every priority discussion carries an Action (Respond, Answer, Pin, Close, Convert to Issue), a suggested reply, and any follow-up (create FAQ, update docs).
- The report flags discussions that should become issues or PRs, community members who consistently help others, discussions that indicate documentation gaps, and "answered" discussions that aren't marked as such.

## Anti-criteria

- Never renders a Good/healthy state, or zero discussions, from a list that is a hole.
- Never has a discussion reply claim a change is done before that change landed in the source of truth and was verified by diff read-back (FIX-IN-SOURCE-FIRST).

## Safety gates

When a discussion produces an actual change (docs fix, FAQ entry, code change), it follows the SKILL.md FIX-IN-SOURCE-FIRST gotcha before the discussion reply claims it's done.

## Inputs

- **project** (optional): one repo from `OSS_REPOS`. If omitted, checks every listed repo. A repo Config.md § Out of scope routes elsewhere is pointed there.

## Tool contract

### Live Data (pre-injected)

The 30 most recently updated discussions (with bodies, category, upvotes, comment counts and `answerChosenAt`) for every repo in `OSS_REPOS`, from the GraphQL API, as one JSON object (shape and hole semantics: `Tools/Fetch.help.md`).

! `bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts discussions || echo "ERROR: Fetch.ts failed (auth/scope/network) — NOT zero results"`

### Intent-to-Flag Mapping

| Input | Flags |
|-------|-------|
| **project** named | `--repo <name>` (a name from `OSS_REPOS`) |
| More than 30 | `--limit N` |

## Output format

Discussion categories:

| Category | Description |
|----------|-------------|
| **Q&A** | Questions seeking help or clarification |
| **Ideas** | Feature suggestions, brainstorming |
| **Show and Tell** | Community showcasing their work |
| **General** | General conversation, announcements |
| **Polls** | Community voting on decisions |

Priority levels:

| Priority | Criteria |
|----------|----------|
| **High** | Unanswered Q&A with many upvotes, active discussion, potential PR |
| **Medium** | Recent questions, moderate engagement, ideas worth considering |
| **Low** | Show and tell (acknowledge), old unanswered, off-topic |

```markdown
## Discussions Report

### Summary
- **Total Active Discussions:** X across all projects
- **Unanswered Q&A:** X (needs attention)
- **Hot Topics:** [List of trending themes]
- **Community Health:** [Assessment]

### <repo> (X discussions)
**Category Breakdown:** Q&A: X | Ideas: X | Show & Tell: X

#### Needs Response (Unanswered Q&A)
1. **#12: [Title]**
   - Asked by: @author ([date])
   - Upvotes: X | Comments: Y
   - **Question Summary:** [Brief summary]
   - **Suggested Answer:** "[response]"

#### Hot Ideas
1. **#8: [Title]** - X upvotes
   - **Idea Summary:** [Brief summary]
   - **Recommendation:** [Consider for roadmap / Too complex / Already planned]

#### Community Highlights
- @user shared [interesting project built on <repo>]
- Discussion #15 could become a FAQ entry

[One section per repo in OSS_REPOS order, same format]

### Trending Themes
1. **[Theme]** - Appears in X discussions
   - Action: [Create docs section / Pin FAQ / Address in README]
2. [...]

### Quick Wins
- Answer Discussion #12 in <repo> (common question, easy answer)
- Pin Discussion #8 in <repo> (valuable resource)
- Close Discussion #3 (resolved, stale)
```
