# Vendored libraries

Used only by the Payment Risk Checker's "Download results (PDF)" button
(`projects/payment-risk-ui.js`). They are loaded from this site on the first
PDF click; nothing is fetched from a CDN at runtime and no data leaves the browser.
Files are the unmodified minified UMD builds. See D-008 in `docs/payment-risk/DECISIONS.md`.

| File | Package | Version | Source URL | sha256 | License |
|---|---|---|---|---|---|
| `jspdf-2.5.2.umd.min.js` | jspdf | 2.5.2 | https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js | `85ba2cc3ff858a20fa49fe6e457bec863ea40b55a9f3725e58a940e62f6f61a4` | MIT, `LICENSE-jspdf.txt` |
| `jspdf-autotable-3.8.4.min.js` | jspdf-autotable | 3.8.4 | https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js | `2223830cf9a1ec85af014cc71b37c1b1eb566f3d18b2ab8071e96af822c58bdb` | MIT, `LICENSE-jspdf-autotable.txt` |

Hashes were cross-checked against the same files on unpkg.com (identical).
To verify: `shasum -a 256 projects/vendor/*.js`.
To upgrade: download the new exact version, inspect it, update the file name, this table,
and the paths in `payment-risk-ui.js`.
