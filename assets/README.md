# assets/

Generated demo GIFs and static images for the README and landing page.

These are **built artifacts** — regenerate them with VHS, don't hand-edit:

```sh
vhs tapes/hero.tape        # → hero.gif
vhs tapes/zoom.tape        # → zoom.gif
vhs tapes/themes.tape      # → themes.gif
vhs tapes/dashboard.tape   # → dashboard.gif
```

See [`../tapes/README.md`](../tapes/README.md) for the full recording workflow.

The README references `hero.gif` via an absolute
`raw.githubusercontent.com/.../main/assets/hero.gif` URL so it renders on both
GitHub and npmjs.com. Generate and commit the GIFs to `main` before publishing.

## Social preview image

`social-preview.svg` is the source for the GitHub repo social preview / OG image
(1280×640, Matrix-green aesthetic). GitHub's *Settings → Social preview* upload
needs a **PNG/JPG**, so rasterize it first:

```sh
# Option A — resvg (no browser, fast):
npx -y @resvg/resvg-js-cli assets/social-preview.svg assets/social-preview.png

# Option B — librsvg (brew install librsvg):
rsvg-convert -w 1280 -h 640 assets/social-preview.svg -o assets/social-preview.png
```

Then upload `social-preview.png` in the repo's Social preview setting. The
landing page references it as its `og:image` for link unfurls.
