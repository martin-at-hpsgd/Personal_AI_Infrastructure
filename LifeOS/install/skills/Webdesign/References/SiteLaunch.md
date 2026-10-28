# Public site launch completeness

A public-site build includes its launch infrastructure. The visual page alone is not the finished deliverable. This applies to new public sites and requests to complete an existing launch, not isolated components or local mockups.

## Required outcome

The project ISA contains independently verifiable criteria for these outcomes before implementation:

- The site's identity survives tabs, bookmarks, phone shortcuts, and sharing: logo, SVG/favicon fallback, touch icon, appropriately sized raster social card, and resolving head references. Open Graph and X metadata use the canonical origin and include descriptive image alt text. The manifest, robots policy, and sitemap match the site's actual routes and intended indexing.
- Build and sanctioned deploy commands assert the emitted output, including asset formats/dimensions, local references, canonical metadata, and analytics source identity. Assertions use the real output directory from the project's configuration. Source-file existence does not prove packaging.
- Every applicable registration and integration in the installation's operational rules is complete and verified against its live authority. The project's Bunker contract carries the actual probes and can be run through `bunker test`; source registration and cloud deployment are separate criteria.
- Browser evidence covers the rendered assets and the page at desktop/mobile widths. Analytics evidence covers the actual pageview and engagement path plus its reporting destination. Security evidence covers the curated deployed target, relevant protected/data paths, and headers. Missing verifiers remain visibly open.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Installation-specific sources

Use `SystemContext.ts load operations` and the operational rules it routes to. In LifeOS, `LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md` § Deployment owns brand and deploy requirements; `LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md` § Bunker registration owns the full same-motion registration checklist, including both Bunker planes, project discovery, the public-project mirror obligation, and all analytics registries. Read those sections in full. They are the single source for mutable installation details, not this skill.

The build is prepared and verified before approval is requested for any action held by the existing authorization policy. A held deployment leaves live-dependent criteria open and names the exact remaining action. This intent grants no new publication, credential, or infrastructure permissions.
