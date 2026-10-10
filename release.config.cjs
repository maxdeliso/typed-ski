module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "node scripts/release_prepare.js ${nextRelease.version} && pnpm exec jsr publish --dry-run --allow-dirty",
        publishCmd: "pnpm exec jsr publish --allow-dirty",
      },
    ],
    "@semantic-release/github",
  ],
};
