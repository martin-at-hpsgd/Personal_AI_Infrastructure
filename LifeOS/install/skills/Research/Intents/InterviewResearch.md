# Perform Interview Research

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples · References

Research on a company plus 10 surprise-maximizing interview questions (Shannon surprise principle) for an interview, in the question style the principal's preferences name.

## Ideal State

- StandardResearch findings on {company_name} covering all five areas existed before any question was written: recent activity and announcements (last 6 months), technical innovation, social media and thought leadership, competitive landscape, and future direction.
- A COMPANY SUMMARY of 2-3 paragraphs states what they're building and why it matters, recent momentum and achievements, what they seem most excited about, and key differentiators from competition.
- Exactly 10 INTERVIEW QUESTIONS are delivered, written in the question style set in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Research/PREFERENCES.md` § InterviewResearch when that file sets one, else the Question principles under References (unexpected angles, implicit assumptions challenged, "production function" thinking), to maximize surprise and information content per the Shannon principle; they elicit stories, not just facts, and reveal mental models and decision-making processes.
- The questions cover the three required themes, each reframed in a novel way: problem definition and origin story, competitive differentiation and strategy, and future vision and industry evolution.
- Every question carries its **Q[number]:**, a **Why:** naming the surprising insight it might reveal, and one **Follow-up angle:** based on likely answers.

## Anti-criteria

- No obvious or boring questions, and none with predictable answers: questions and answers should never be boring (the ❌ Boring forms under Examples are the failure).

## Inputs

A company name for an interview, often a tech startup (PREFERENCES.md § InterviewResearch may name the usual interview context).

## Tool contract

### Research Protocol

Run the StandardResearch intent (`Intents/StandardResearch.md`) on **{company_name}** across these areas:

1. **Recent Activity & Announcements** (last 6 months)
   - Product launches and updates
   - Funding rounds or business milestones
   - Press releases and media coverage
   - Conference talks or presentations

2. **Technical Innovation**
   - Core technology and approach
   - Patents or research papers
   - Technical blog posts
   - Open source contributions

3. **Social Media & Thought Leadership**
   - CEO/founder social media activity
   - Company blog posts
   - Podcast appearances
   - Industry commentary and opinions

4. **Competitive Landscape**
   - Direct competitors and alternatives
   - Market positioning
   - Unique differentiators
   - Industry trends they're responding to

5. **Future Direction**
   - Roadmap hints or statements
   - Job postings (what roles they're hiring)
   - Strategic partnerships
   - Market expansion signals

### Research brief

The research query: `{company_name} - focus on: recent announcements, technical innovation, competitive positioning, founder/executive social media, future direction signals, and any contrarian or surprising aspects of their approach`.

## Output format

A COMPANY SUMMARY (2-3 paragraphs), then INTERVIEW QUESTIONS (10 total), each in the Question Format below.

**Additional themes to explore**:
- Counter-intuitive insights they've discovered
- Failed experiments and pivots
- Hiring philosophy and team building
- Customer surprises or unexpected use cases
- Technical trade-offs and architecture decisions
- Market timing and "why now"
- Contrarian beliefs about their industry

### Question Format:
For each question, provide:
- **Q[number]:** The actual question
- **Why:** Brief explanation of what surprising insight this might reveal
- **Follow-up angle:** One potential follow-up based on likely answers

## Examples

### Example Question Transformations

❌ **Boring**: "What problem are you solving?"
✅ **Interesting**: "What problem did you initially *think* you were solving, and when did you realize you were actually solving something completely different?"

❌ **Boring**: "How are you different from competitors?"
✅ **Interesting**: "If your top competitor called you for advice on what they should build next, what would you tell them - and what would you deliberately leave out?"

❌ **Boring**: "What's your vision for the future?"
✅ **Interesting**: "If you woke up in 2030 and your company had failed, what would be the most likely reason - and what could make that failure look obvious in retrospect?"

## References

### Question Principles

Apply these techniques:
- **Oblique approach**: Ask about adjacent topics to reveal core insights
- **Production function**: "What inputs create your outputs?"
- **Marginal thinking**: "What's the next bottleneck?"
- **Status quo challenge**: "What does everyone else get wrong?"
- **Personal history**: "What experience shaped this decision?"
- **Taste and aesthetics**: "What do you find beautiful about your solution?"
- **Edge cases**: "When does your approach fail?"
- **Second-order effects**: "What happens when you succeed?"

### Shannon Surprise Principle

Maximize information entropy by:
- Avoiding questions with predictable answers
- Seeking insights that contradict conventional wisdom
- Finding the "least likely but most important" aspects
- Revealing hidden complexity in apparently simple systems
- Exposing assumptions that aren't being questioned
