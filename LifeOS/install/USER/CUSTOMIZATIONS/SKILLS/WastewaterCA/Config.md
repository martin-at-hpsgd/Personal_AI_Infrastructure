---
provenance: template
version: 1.0.0
---

# Wastewater region

Read by the wastewater skill's `Tools/Wastewater.ts` and its intents. Replace the sample region below with the counties you care about, or delete this file to run everything statewide.

- region: Sacramento area
- counties: Sacramento 06067; Yolo 06113; Placer 06061
- rpho region: Greater Sierra-Sacramento

`counties` is `Name FIPS` pairs separated by `;`. The name is matched against CDC's `counties_served` text, the 5-digit FIPS code (California codes start `06`) against CDPH's `county_names`. `rpho region` is the `RPHO_REGION` value in the CHHS Respiratory Virus Dashboard, used for the optional clinical layer; its values are Bay Area, Central California, Greater Sierra-Sacramento, Los Angeles, Rural North, Southern California and California.
