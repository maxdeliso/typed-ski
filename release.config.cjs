module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        prepareCmd: "node scripts/release_prepare.js ${nextRelease.version}",
        publishCmd: "jsr publish --allow-dirty",
      },
    ],
    "@semantic-release/github",
  ],
};
