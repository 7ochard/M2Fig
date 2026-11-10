# Mg2Fig contributor guide

Read README.md, ATTRIBUTION.md and LICENSE before changing or redistributing this project.
Mg2Fig is derived from Aaron Xu / AaronXu-Lab's MasterGo2Figma at
commit d6d93574b1c695906300d60712697a03b795877e; retain attribution and CC BY-NC-SA 4.0.
Third-party dependencies keep their own license notices.

- Preserve the v2/v3 data format, source/component identities and retained-import failure semantics.
- Keep Figma plugin ID 2712095548761342 unless an intentional release migration is requested.
- Edit ReceiveFromMasterGo/ui-src, then build; do not hand-edit generated ui.html.
- Test: node --test tools/tests/*.test.js; cd desktop and run npm test.
- Build both plugins with npm ci and npm run build in their respective directories.
- Package: powershell -File tools/packageMg2FigV3.ps1.
- Desktop setup: SetupMg2Fig.cmd. Runtime paths are generated locally; never commit them.
- Use synthetic test fixtures. Never commit design files, client names, caches, logs or credentials.
- Preserve local work; do not reset or recursively delete user directories.
- Do not claim a real GUI or design migration test from static checks alone.

Upstream format documentation is available at:
https://github.com/AaronXu-Lab/MasterGo2Figma/tree/d6d93574b1c695906300d60712697a03b795877e/docs
