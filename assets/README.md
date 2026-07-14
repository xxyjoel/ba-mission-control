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
