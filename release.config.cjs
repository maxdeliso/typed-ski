module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        prepareCmd: "node scripts/release_prepare.js ${nextRelease.version}",
        publishCmd: "npx --yes jsr publish",
      },
    ],
    "@semantic-release/github",
  ],
};
