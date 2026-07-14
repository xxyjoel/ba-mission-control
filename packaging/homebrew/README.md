# Homebrew tap

`mission-control.rb` is the Homebrew formula for BlueArch Mission Control. It
installs the published npm package as a native `brew` command — matching the
"Homebrew tier" install path (like cmux offers).

## One-time: create the tap repo

Homebrew taps are just Git repos named `homebrew-<tap>`:

1. Create a public repo `xxyjoel/homebrew-tap`.
2. Copy the formula into it at `Formula/mission-control.rb`.
3. Push.

```sh
gh repo create xxyjoel/homebrew-tap --public -d "Homebrew tap for BlueArch tools"
git clone https://github.com/xxyjoel/homebrew-tap && cd homebrew-tap
mkdir -p Formula
cp ../ba-mission-control/packaging/homebrew/mission-control.rb Formula/
git add Formula && git commit -m "mission-control 1.0.0" && git push
```

## Per-release: publish npm, then set the sha256

The formula pulls the npm tarball, so publish first, then pin its hash:

```sh
npm publish --access public                                    # from the app repo
URL=https://registry.npmjs.org/@bluearch/mission-control/-/mission-control-1.0.0.tgz
curl -sL "$URL" | shasum -a 256                                # paste into `sha256`
```

Bump `url` + `sha256` on each new version (or automate with
`brew bump-formula-pr`).

## Users install with

```sh
brew tap xxyjoel/tap
brew install mission-control
mc
```

## Verify locally before publishing the tap

```sh
brew install --build-from-source ./mission-control.rb   # needs a real sha256
brew test mission-control
brew audit --strict --new mission-control
```
