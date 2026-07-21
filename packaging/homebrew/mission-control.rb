# Homebrew formula for BlueArch Mission Control.
#
# This lives here as the source of truth; to publish it, copy it into the tap
# repo `bluearchio/homebrew-tap` at `Formula/mission-control.rb` (see README.md
# in this directory). Then users install with:
#
#     brew tap bluearchio/tap
#     brew install mission-control
#
# The formula installs the published npm package (@bluearch/mission-control),
# so `npm publish` must happen first. After publishing, fill in the sha256:
#
#     curl -sL https://registry.npmjs.org/@bluearch/mission-control/-/mission-control-1.0.0.tgz | shasum -a 256
#
# and bump `url`/`sha256` on each release (or automate with `brew bump-formula-pr`).

require "language/node"

class MissionControl < Formula
  desc "Keyboard-first terminal TUI for managing up to 10 Claude Code agent sessions"
  homepage "https://github.com/xxyjoel/ba-mission-control"
  url "https://registry.npmjs.org/@bluearch/mission-control/-/mission-control-1.0.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_NPM_PUBLISH"
  license "AGPL-3.0-only"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir[libexec/"bin/*"]
  end

  test do
    # `mc` boots an interactive TUI that requires a real TTY (raw mode), so we
    # don't launch it here — just assert the CLI was linked and is executable.
    assert_path_exists bin/"mc"
    assert_predicate bin/"mc", :executable?
  end
end
