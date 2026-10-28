# Iterative Depth — Scientific Foundation

Examining the same phenomenon N times, each from a systematically different angle, yields understanding that no single examination can achieve. "Iterative Depth" is not a single named technique; it is a meta-pattern that cognitive scientists, AI researchers, requirements engineers, designers and philosophers reached independently. The 20 techniques below ground it, and `TheLenses.md` cites them by name.

## Validated Techniques by Domain

### Cognitive Science & Epistemology

| # | Technique | Origin and source | What it grounds here |
|---|-----------|-------------------|----------------------|
| 1 | Hermeneutic Circle | Hans-Georg Gadamer, *Truth and Method* (1960); Stanford Encyclopedia of Philosophy | Understanding cycles between parts and whole; each pass refines the pre-understanding of what the user wants |
| 2 | Triangulation | Norman Denzin, *The Research Act* (1970); PMC: Principles, Scope, and Limitations of Methodological Triangulation | Method, investigator, theory and data-source triangulation overcome single-method bias; each pass is a different method on the same problem |
| 3 | Cognitive Flexibility Theory | Rand Spiro et al., *Cognition and Instruction* (1988) | "Criss-crossing the landscape" from different directions aids transfer; each lens is a different crossing |
| 4 | Dialectical Thinking | Hegel, refined by many | Thesis, antithesis, synthesis; the constraint-inversion and failure lenses are structured antithesis |
| 5 | Reflective Equilibrium | John Rawls, *A Theory of Justice* (1971); Nelson Goodman, *Fact, Fiction, and Forecast* (1955); Stanford Encyclopedia of Philosophy | Working back and forth between judgments and principles until they cohere; each pass revises the ISC model until it coheres |
| 6 | Equilibration | Jean Piaget, *The Equilibration of Cognitive Structures* (1975) | Conflicting information forces mental models to restructure; each new lens creates productive disequilibrium |
| 7 | Abductive Reasoning | Charles Sanders Peirce, Harvard Lectures on Pragmatism (1903); Stanford Encyclopedia of Philosophy | Provisional hypotheses tested and revised; different outputs from the same prompt are different hypotheses, so AI non-determinism is useful rather than noise |
| 8 | Progressive Refinement of Mental Models | Gentner & Stevens, *Mental Models* (1983); Johnson-Laird, *Mental Models* (1983) | Early passes set rough structure, later ones add precision and catch edge cases; why each successive pass goes deeper |
| 9 | Multiple External Representations / DeFT Framework | Shaaron Ainsworth, *Learning and Instruction*, 16(3), 183-198 (2006) | Representations complement, constrain and construct; they must be sufficiently different, since too similar wastes cycles and too different loses coherence. Supports the 2-8 pass range and lenses that are structurally different, not re-runs |
| 10 | Perspectivism | Friedrich Nietzsche, *On the Genealogy of Morals* (1887); Ronald Giere, *Scientific Perspectivism* (2006) | "The more eyes, different eyes, we train on the same matter, the more complete will our concept of it be"; objectivity accumulates from partial views |

### AI/ML & Prompt Engineering

| # | Technique | Origin and source | What it grounds here |
|---|-----------|-------------------|----------------------|
| 11 | Self-Consistency | Wang et al., 2022, arXiv:2203.11171 | Diverse reasoning paths, most consistent answer: +17.9% on GSM8K, +11.0% on SVAMP, +12.2% on AQuA over single-path chain-of-thought; multiple paths are multiple lenses |
| 12 | Multi-Agent Debate | Du et al., 2023, arXiv:2305.14325 | Agents converge on better answers through structured disagreement; each pass can be a different agent perspective |
| 13 | Ensemble Methods | Breiman, Schapire, Freund | Bagging, boosting and random forests beat any single model; combined passes are an ensemble of requirements |
| 14 | DiVeRSe (Diverse Verifier on Reasoning Step) | Li et al., 2023 | Structurally diverse prompts with step verification give better coverage; structurally different lenses are diverse prompting |

### Requirements Engineering

| # | Technique | Origin and source | What it grounds here |
|---|-----------|-------------------|----------------------|
| 15 | Viewpoint-Oriented Requirements Engineering | Finkelstein & Nuseibeh, 1992; Requirements Engineering Journal; IEEE Conf on RE | Inconsistencies between stakeholder viewpoints reveal hidden requirements; the stakeholder lens |
| 16 | Misuse Cases | Sindre & Opdahl, 2005 | The adversary's view uncovers security and safety requirements; the failure/adversarial lens |
| 17 | Progressive Elaboration | PMBOK/PMI | Each pass adds precision to initially vague requirements |

### Design Thinking & Problem Solving

| # | Technique | Origin and source | What it grounds here |
|---|-----------|-------------------|----------------------|
| 18 | Six Thinking Hats | Edward de Bono, *Six Thinking Hats* (1985) | Facts, emotions, risks, benefits, creativity and process applied in sequence; the direct inspiration for the 8 lenses |
| 19 | Causal Layered Analysis | Sohail Inayatullah, *Futures* (1998); metafuture.org | Litany, structural causes, worldview, myth; progressive depth, not only different angles |
| 20 | Soft Systems Methodology | Peter Checkland, 1981 | Multiple root definitions from different worldviews via CATWOE; each pass builds a different root definition of ideal state |

## Key Distinction: CS Iterative Deepening vs. Iterative Depth

| Aspect | CS Iterative Deepening (IDDFS) | Iterative Depth (this technique) |
|--------|-------------------------------|----------------------------------|
| **Domain** | Graph/tree search algorithms | Problem understanding & requirements |
| **What iterates** | Depth limit of search | Perspective/angle of exploration |
| **Same path?** | Yes, revisits same nodes | No, structurally different each time |
| **Purpose** | Find optimal path in state space | Extract complete understanding |
| **Invented by** | Korf (1985) | Meta-pattern across many fields |
| **Output** | Single solution path | Enriched set of requirements/criteria |

The CS technique searches the same tree deeper each time; this one searches the same problem from different angles each time. They share the benefit of re-examination and differ in mechanism.

## Why It Works: Three Mechanisms

1. **Perspective blindness compensation.** Any single viewpoint has blind spots, and structured rotation through viewpoints covers gaps no individual pass catches.
2. **Productive non-determinism.** Even with the same lens, AI non-determinism surfaces slightly different aspects on each pass; combined with structural variation, that variety is useful.
3. **Progressive pre-understanding.** Each pass updates what the analyst knows to look for (Gadamer), so pass 5 sees things pass 1 could not.
