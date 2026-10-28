# D3.js Interactive Dashboards Intent

> **Palette.** The colour names and hex values in this intent are the skill's neutral defaults (indigo `#2B4C7E` primary accent, green `#3A7D44` secondary accent, umber `#A0522D` warm wash, `#F5F5F0` paper ground). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette exists, use its value for each role instead, in prompts, validation and checklists alike, and name its colour words where this file names the defaults.

**Contents:** Ideal State · Anti-criteria · Inputs · Output format · Examples · References

Creates sophisticated, interactive D3.js data visualizations for dashboards, reports, and data analysis.

## Ideal State

- The chart type fits the question the data answers, drawn from the supported types under References (charts and graphs, network and relationships, advanced).
- Every plotted value traces to the input data, and data validation drops null, undefined and non-numeric values before render, with a visible error message (never a blank chart) when the container is missing or the data is empty.
- The deliverable is one of the Output formats: a complete standalone HTML artifact (D3.js via CDN or inline, responsive container, interactive controls), a reusable JavaScript function with configurable parameters and documentation comments, or a dashboard page (multi-chart layout, coordinated interactions, shared data filtering, export/download).
- Every colour comes from the LifeOS palette under Output format, and the typography follows its sizes.
- Every axis is labelled, every multi-series chart has a legend, and nothing overflows or is cropped as the container resizes.
- Tooltips, zoom and transitions work when the page is opened in a real browser, with no console errors.
- It is accessible: ARIA labels and keyboard navigation.

## Anti-criteria

- No generic color schemes: d3's default `d3.schemeCategory10`, `d3.schemeSet3`, `d3.interpolateViridis` or `d3.interpolatePlasma` in place of the palette.
- No static-only presentation when interactivity makes sense.
- No missing axis labels or legends.
- No overflow or cropped elements.
- Not used for static diagrams (use TechnicalDiagrams or Mermaid intents), editorial illustrations (use Essay intent), or simple infographics (use other visualization intents).

## Inputs

The data to plot and the question it answers.

**Use for:**
- Consulting and planning dashboards (project dependencies, constraint analysis)
- Blog post data visualizations (statistics, trends, relationships)
- Network diagrams (system architecture, organizational relationships)
- Interactive reports and presentations

## Output format

### Color Palette (neutral default)

**Primary Colors:**
```
Deep Indigo: #2B4C7E   - Primary accent
Deep Green:   #3A7D44   - Secondary accent
Charcoal:    #2D2D2D   - Text and lines
```

- These are the skill defaults; when `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color Palette sets other accents, those replace them.
- Categorical and sequential scales are built from these colours, with sufficient contrast for accessibility.
- Blockers and bottlenecks in planning dashboards are red `#D32F2F`, set against indigo `#2B4C7E` or green `#3A7D44` for the rest.

**Typography:**
- System fonts: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`
- Label sizes: 12px for axes, 14px for titles
- Consistent spacing and alignment

### Output Formats

### HTML Artifact
- Complete standalone HTML file
- Embedded D3.js library (CDN or inline)
- Responsive container
- Interactive controls

### Code Snippet
- Reusable JavaScript function
- Configurable parameters
- Documentation comments

### Dashboard Page
- Multi-chart layout
- Coordinated interactions
- Shared data filtering
- Export/download functionality

## Examples

Planning dashboard patterns:
- **Project dependency network:** a force-directed graph (`d3.forceSimulation` with link, charge and center forces), blocker nodes in `#D32F2F`, the rest in `#2B4C7E`.
- **Constraint analysis:** a bar chart of constraints by impact, bottlenecks in `#D32F2F`, the rest in `#3A7D44`.
- **Progress dashboard:** a gauge of current against target customers beside growth rate and open blockers.

Element counts: under 1,000, SVG is optimal; 1,000-10,000, consider canvas rendering; over 10,000, implement virtual scrolling or aggregation.

## References

### Supported Visualization Types

### Charts & Graphs
- **Bar Charts** - Comparisons, rankings, distributions
- **Line Charts** - Trends over time, performance metrics
- **Scatter Plots** - Correlations, clusters, outliers
- **Area Charts** - Cumulative values, stacked comparisons
- **Pie/Donut Charts** - Proportions, percentages

### Network & Relationships
- **Force-Directed Graphs** - Project dependencies, team relationships
- **Tree Diagrams** - Hierarchies, organizational structures
- **Chord Diagrams** - Entity relationships, data flow
- **Sankey Diagrams** - Flow visualization, process mapping

### Advanced
- **Heatmaps** - Intensity, density, correlation matrices
- **Geographic Maps** - Location data, regional analysis
- **Timeline Visualizations** - Project milestones, historical data
- **Custom Dashboards** - Multi-chart compositions

**Official Documentation:**
- https://d3js.org/
- https://observablehq.com/@d3/gallery
