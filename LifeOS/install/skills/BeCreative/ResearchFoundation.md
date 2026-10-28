# Research Foundation: Verbalized Sampling

Verbalized Sampling (Zhang et al., 2025, arXiv:2510.01171) asks a model for several responses with stated probabilities and samples from the low-probability tail (p<0.10), instead of asking for one answer. Alignment training pushes models toward the most typical response; asking for a verbalized distribution recovers the diversity the base model still encodes. The paper reports 1.6-2.1x more diversity on creative-writing tasks with no quality loss.

What this means in practice:

- **It helps where many answers are valid**: writing, naming, angles, ideas, synthetic examples.

- **It does nothing for tasks with one correct answer** (paper §3.2). Don't reach for it on factual questions.

- **"Confidence" beats "probability" as the elicitation word** for multi-turn corpus expansion (paper §H.3).

- **Self-reported probabilities are unreliable.** Judge diversity by comparing the candidates, never by the numbers the model attached to them.
