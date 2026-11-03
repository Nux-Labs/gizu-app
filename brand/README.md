# Gizu brand kit

| File | Size | Use |
|------|------|-----|
| `gizu-x-avatar.png` | 400x400 | X profile picture |
| `gizu-x-cover.png` | 1500x500 | X header image |
| `social-media/anonymous-investors.png` | 1600x900 | X post, regenerate with `node brand/social-media/anonymous-investors.mjs` |

The X avatar and cover are rendered by `node brand/gizu-x.mjs` from the landing's ASCII chameleon field; it writes the `.html` sources and the PNGs.

Colors: ink `#04060a`, cyan `#7ce8f2`, violet `#b9a6ff`, text `#f1f4f8`.

The cover keeps the lower left corner clear so the profile picture does not cover the headline.
