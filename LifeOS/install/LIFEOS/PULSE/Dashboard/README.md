# Pulse Dashboard

The full Pulse as a display: a separate Electron app for an always-visible monitor. It shows the same live Pulse at `localhost:31337` and manages no sessions — no terminals, no shell, no PTY. Pulse Desktop stays the place to work; this is the place to look.

**Tabs.** A page strip under the header lists DASHBOARD and every Pulse page in the canonical nav-manifest order, with the manifest's icons. A page tab shows that live Pulse page full-bleed in a sandboxed native view with Pulse's own header hidden. DASHBOARD is the pane composition.

**Panes.** The bottom half of the window, full width, is the agent board: Pulse's own `/agents` route in wall mode (`?wall=lanes`), six lifecycle lanes side by side filling that half and scrolling internally. The top half is the cards, priorities first. Live climb is the same route in spotlight mode (`?wall=spotlight`). Agenda, health, cameras, Surface, local news and status are read-only feeds. **Arrange panes** moves, resizes and removes panes; **Add pane** restores them. Layout and window position persist on this Mac. **Privacy** hides every pane. **Tour** cycles the tabs every 20 seconds until any click or key.

**Keys.** ⌘1 Dashboard · ⌘[ / ⌘] previous and next tab · ⌘P privacy · ⌘T tour · ⌘E arrange · ⌘R reload.

Embedded pages reconnect automatically after a crash, failed navigation or a 20-second loading timeout. While reconnecting, the dashboard shows a dark status message. All six agent lanes stay side by side in one row across the full dashboard width; cards scroll vertically within each lane. ⌘R reloads the embedded pages as well as the dashboard shell.

**Theme.** Pulse's navy design tokens (mirrored from `Observability/src/app/globals.css`, kept equal by `theme.test.ts`) and the LifeOS faces: Advocate for the brand and labels, Concourse for text, Triplicate for metadata.

Run `bun test` and `bun run build`. `bun run start` launches with the Electron toolchain installed for Pulse Desktop; `bun run package` produces the macOS bundle under `release/`. The app never starts, stops or alters Pulse, Pulse Desktop or terminals. Start the Pulse service if panes report unavailable.
