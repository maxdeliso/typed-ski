"""Bazel rule for compiling TypeScript with tsgo (TypeScript 7 native)."""

def _ts_compile_impl(ctx):
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    out_dir = ctx.actions.declare_directory(ctx.attr.out_dir)

    tsgo_path = None
    tsgo_file = None
    for f in ctx.files.node_modules:
        if f.path.endswith("/@typescript/native-preview") or f.path.endswith("\\@typescript\\native-preview"):
            tsgo_path = f.path + "/bin/tsgo.js"
            tsgo_file = f
            break
        if f.path.endswith("/@typescript/native-preview/bin/tsgo.js") or f.path.endswith("\\@typescript\\native-preview\\bin\\tsgo.js"):
            tsgo_path = f.path
            tsgo_file = f
            break
    
    if tsgo_path == None:
        fail("Cannot find @typescript/native-preview/bin/tsgo.js in node_modules")

    ts_config_generated = ctx.actions.declare_file(ctx.label.name + "_tsconfig.json")

    ups = "/".join([".." for _ in ctx.bin_dir.path.split("/")])

    config_content = """{
  "extends": "%s/%s",
  "compilerOptions": {
    "outDir": "./%s",
    "noEmit": false,
    "skipLibCheck": true,
    "typeRoots": ["./node_modules/@types"],
    "types": ["node", "random-seed"],
    "rootDirs": ["./", "%s"],
    "paths": {
       "*": ["./node_modules/*", "%s/*"]
    },
    "preserveSymlinks": true
  },
  "include": [
    "%s/bin/**/*",
    "%s/compiler/**/*",
    "%s/lib/**/*",
    "%s/scripts/bazel.ts",
    "%s/scripts/bazelBuildDist.ts",
    "%s/test/**/*"
  ]
}""" % (ups, ctx.file.tsconfig.path, ctx.attr.out_dir, ups, ups, ups, ups, ups, ups, ups, ups)
    
    ctx.actions.write(ts_config_generated, config_content)

    data_files = [f for f in ctx.files.srcs if not f.path.endswith(".ts") and not f.path.endswith(".tsx") and f.path != ctx.file.tsconfig.path]
    
    wrapper_script = ctx.actions.declare_file(ctx.label.name + "_wrapper.mjs")
    
    script_content = """
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const [node, tsgo, ...args] = process.argv.slice(2);

// tsgo caps type-checking workers at 4 by default and has no auto/all value,
// so pass the sandbox's full core count to use every core.
// os.availableParallelism() is always >= 1, the minimum --checkers takes.
const checkers = os.availableParallelism();
console.log(`Running tsgo with ${checkers} checkers...`);
const tsgoResult = spawnSync(node, [tsgo, '--checkers', String(checkers), ...args], { stdio: 'inherit' });
if (tsgoResult.status !== 0) {
    console.error('tsgo failed with status', tsgoResult.status);
    process.exit(tsgoResult.status || 1);
}

// Copy data files
const dataFiles = %s;
const targetOutDir = '%s';
console.log(`Copying ${Object.keys(dataFiles).length} data files to ${targetOutDir}...`);
for (const [src, shortPath] of Object.entries(dataFiles)) {
    const dest = path.join(targetOutDir, shortPath);
    // console.log(`Copying ${src} to ${dest}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}
console.log('Copying complete.');
""" % (str({f.path: f.short_path for f in data_files}), out_dir.path)

    ctx.actions.write(wrapper_script, script_content)

    args = ctx.actions.args()
    args.add(wrapper_script.path)
    args.add(node_toolchain.nodeinfo.node.path)
    args.add(tsgo_path)
    args.add("--project")
    args.add(ts_config_generated.path)

    all_inputs = depset(
        ctx.files.srcs + [ctx.file.tsconfig, ts_config_generated, tsgo_file, wrapper_script],
        transitive = [depset(ctx.files.node_modules)],
    )

    ctx.actions.run(
        executable = node_toolchain.nodeinfo.node,
        arguments = [args],
        inputs = all_inputs,
        outputs = [out_dir],
        mnemonic = "TsCompile",
        progress_message = "Compiling TypeScript and copying data for %s" % ctx.label,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([out_dir]))]

ts_compile = rule(
    implementation = _ts_compile_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True),
        "node_modules": attr.label_list(allow_files = True),
        "tsconfig": attr.label(allow_single_file = True, mandatory = True),
        "out_dir": attr.string(default = "ts_out"),
    },
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
