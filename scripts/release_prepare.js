import { execSync } from "node:child_process";
import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Error: version argument is required");
  process.exit(1);
}

console.log(`Preparing release files for version ${version}...`);

// 1. Update package.json version field
const pkgPath = "package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// 2. Build Bazel targets
console.log("Building Bazel release targets...");
execSync(
  `bazel build //:dist_artifacts //:jsr_generated_src //lib/shared:version_generated_src`,
  {
    stdio: "inherit",
    env: { ...process.env, RELEASE_VERSION: version },
  },
);

// 3. Stage files
console.log("Staging distribution files...");
fs.mkdirSync("dist", { recursive: true });
const filesToCopy = [
  ["bazel-bin/dist_artifacts/tripc.js", "dist/tripc.js"],
  ["bazel-bin/dist_artifacts/tripc.min.js", "dist/tripc.min.js"],
  ["bazel-bin/dist_artifacts/tripc.node.js", "dist/tripc.node.js"],
  ["bazel-bin/dist_artifacts/tripc", "dist/tripc"],
  ["bazel-bin/dist_artifacts/tripc.cmd", "dist/tripc.cmd"],
  ["bazel-bin/jsr.json", "jsr.json"],
  [
    "bazel-bin/lib/shared/version.generated.ts",
    "lib/shared/version.generated.ts",
  ],
];

for (const [src, dest] of filesToCopy) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  Copied: ${src} -> ${dest}`);
    if (dest === "dist/tripc" && process.platform !== "win32") {
      fs.chmodSync(dest, 0o755);
      console.log(`  Set permissions: chmod 755 ${dest}`);
    }
  }
}

console.log("Release prepare step complete!");
