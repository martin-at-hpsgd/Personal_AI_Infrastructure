# Changelog

## 0.15.0 — 2026-10-25
<!-- release: 8bb63bf608c059ed0a425900aa78f96039447fb2 -->
<!-- isc: ISC-412, ISC-413 -->

The Worker now records everything only it sees on the STATVS record, through the bridge's inbox queue so nothing is lost while the Mac is offline: rejected webhooks, sockets and signatures (capped per minute), every incoming call with its admit or refuse reason, passphrase attempts as counts only, calls that end before the passphrase, and every text it sends {{PRINCIPAL_NAME}}. Linq delivery, failure and group membership events are now kept for the record.

## 0.14.0 — 2026-10-25
<!-- release: aeafdb307269a9378656d804769cafdf05fe4bb0 -->
<!-- isc: ISC-405 -->

Call lines now say words the way every other LifeOS voice does: the shared pronunciation pass (homographs like "live", then the principal's rules, pushed as the PRONUNCIATIONS secret).

## 0.13.0 — 2026-10-25
<!-- release: a80a698f37650dd50ad5923b642afd3844c9c2c7 -->
<!-- isc: ISC-404 -->

Declare the Fish voice secrets so a deploy keeps them.

## 0.12.0 — 2026-10-25
<!-- release: 2fefae30a94dd61f9dba00eab703d9ace9532e26 -->
<!-- isc: ISC-404 -->

Call lines render in {{DA_NAME}}'s voice at full Fish quality, the same settings as the desktop voice.

## 0.11.0 — 2026-10-24
<!-- release: fb3c94e83384471a86a7413539b0168bcd2e6e49 -->
<!-- isc: ISC-396 -->

{{DA_NAME}} speaks on phone calls in his own Fish voice now, the greeting included.

## 0.9.3 — 2026-10-24
<!-- release: 4f78b174d28d430caea7e83e903b26b7e344ae95 -->
<!-- isc: ISC-395 -->

{{DA_NAME}} hears your passphrase more reliably on calls: speech recognition is now Deepgram's newest model.

## 0.9.2 — 2026-10-24
<!-- release: 50e3ead1efd3611723cb56f6deb3f2b2cd70245e -->

A passphrase said in pieces, even slowly, is recognised.

## 0.9.1 — 2026-10-24
<!-- release: ec55e603bd8779307735a8a32c1ca9104203214d -->

{{DA_NAME}} keeps waiting while you are still saying the passphrase.

## 0.9.0 — 2026-10-24
<!-- release: 3a556c63f16cd8d3a8be096f9a5f0bb788340c86 -->

Saying your passphrase with a pause in the middle now works, and {{DA_NAME}} waits for you to finish before saying it was wrong.

## 0.7.0 — 2026-10-24
<!-- release: df5b04bc8ec1ab659aab6a219cb7923234239e0a -->

Calling {{DA_NAME}}'s 206 number now gets through: forwarded calls are let in on your number and checked by your passphrase.

## 0.6.2 — 2026-10-24
<!-- release: 0f08d7d077abdd605baa9f4a77f42f09731ea3f1 -->

A call answer's text never arrives twice, even when a send has to be retried.

## 0.6.1 — 2026-10-24
<!-- release: 3981314c0bb4e63a9f66e45ee7f199e232bf4252 -->

Each call answer is texted to you once, even when two arrive together or the Worker restarts mid-send.

## 0.6.0 — 2026-10-24
<!-- release: 565e1a5851d21cfd8e272421ff56f5e7d95d7446 -->

A call answer's text is kept and retried until it reaches you, even if Linq has a hiccup.

## 0.5.1 — 2026-10-24
<!-- release: 510aa6f64224802b008912d81b61f07494a69a27 -->

Every answer {{DA_NAME}} gets from your Mac during a call is read to you and also texted, so you always have it in writing.

## 0.5.0 — 2026-10-24
<!-- release: d1c78f0981049fcc988d379f4d9915d846acba8d -->

If you hang up just as an answer arrives, the answer is texted to you instead of lost.

## 0.4.0 — 2026-10-24
<!-- release: f31845020bde61de7897d507f41498bb223bb56b -->

An answer from the Mac is never spoken in the middle of {{DA_NAME}}'s sentence, and an answer with a link is also texted to you.

## 0.3.5 — 2026-10-24
<!-- release: 4350b5fcfe3a89528f050c7373b3502bc0b738d3 -->

{{DA_NAME}}'s call memory stays consistent when an answer from the Mac arrives while {{DA_NAME}} is still talking.

## 0.3.4 — 2026-10-24
<!-- release: d45977e4f63dc169b2df4c1606875cdb9485d3fa -->

If anything behind a call fails, {{DA_NAME}} says so and the call keeps working.

## 0.3.3 — 2026-10-24
<!-- release: 4016068b209fe939e4da81a24372d71278924f1b -->

Talking over {{DA_NAME}} or hanging up never leaves the call in a broken state or starts work you cut off, and no one but the real call can end it.

## 0.3.2 — 2026-10-24
<!-- release: c996b6d26af0cdcf23e5e4310cdee49a4097e23c -->

{{DA_NAME}}'s spoken replies keep the spaces between words, and hanging up mid-reply stops anything {{DA_NAME}} was about to start.

## 0.3.1 — 2026-10-24
<!-- release: e75a74f2494dab70f42b26e93c4bd6f264d7b056 -->

The call passphrase works with the existing text countersign, salted or not.

## 0.3.0 — 2026-10-24
<!-- release: 8c1097fa19c8557d36207d513633337d81c98afa -->

You can call {{DA_NAME}}: a call from your number is answered, you say your passphrase, and then you talk to {{DA_NAME}}; anything that needs your LifeOS runs on the Mac and the answer is read back to you, or texted if you have hung up.

## 0.2.7 — 2026-10-24
<!-- release: 479124ee5dc2a563dd391c19eb70080f0d315e97 -->

When texts wait in more than one chat, each one's offline notice now arrives on its own without needing another text to wake the inbox.

## 0.2.6 — 2026-10-24
<!-- release: 4d958031139ad7c36826609777b35325f77a65b1 -->

The offline notice goes only to your direct chat with {{DA_NAME}}, once per chat, never to a group.

## 0.2.5 — 2026-10-24
<!-- release: 729a63808707e6d66abfc3e4bb093b609321055f -->

The offline notice remembers which queued texts it already covered, so every text gets at most one notice and none is missed.

## 0.2.4 — 2026-10-24
<!-- release: fa73aa1723bf5762029e53cb5d4bb1bc146caf4c -->

A text sent while the Mac is off, inside the hour after a notice, now gets its own notice when the hour ends.

## 0.2.3 — 2026-10-24
<!-- release: ea284206bb1a28d492ad70c1f4845611ba8ac2f4 -->

A text that waited days for the Mac is still recognised as a duplicate if Linq sends it again after the Mac took it.

## 0.2.2 — 2026-10-24
<!-- release: fcbabfaaefd88f398a1468e32a05446c368decd7 -->

If the offline notice fails to send, it is no longer counted as sent; it is tried again a minute later.

## 0.2.1 — 2026-10-24
<!-- release: 575bcbd7cc1333fc854371f34c3bcc9c8a2931d0 -->

No change in behavior: the config file names its version.

## 0.2.0 — 2026-10-24
<!-- release: 673da7a16c1cc75b4b957b615dd8313cc86df306 -->

First release. Linq webhooks for Tex land here, are checked against Linq's signature, and wait in one inbox until the Mac's bridge takes them, so a text sent while the Mac is off is kept and {{PRINCIPAL_NAME}} gets one offline, queued reply.

