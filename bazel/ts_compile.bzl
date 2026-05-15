"""Bazel rule for compiling TypeScript with tsc."""

def _ts_compile_impl(ctx):
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    out_dir = ctx.actions.declare_directory(ctx.attr.out_dir)

    tsc_path = None
    tsc_file = None
    for f in ctx.files.node_modules:
        if f.path.endswith("/typescript") or f.path.endswith("\\typescript") or f.path.endswith("/typescript/lib/tsc.js") or f.path.endswith("\\typescript\\lib\\tsc.js"):
            if f.is_directory:
                tsc_path = f.path + "/lib/tsc.js"
            else:
                tsc_path = f.path
            tsc_file = f
            break
    
    if tsc_path == None:
        fail("Cannot find typescript/lib/tsc.js in node_modules")

    ts_config_generated = ctx.actions.declare_file(ctx.label.name + "_tsconfig.json")
    
    ups = "/".join([".." for _ in ctx.bin_dir.path.split("/")])
    
    config_content = """{
  "extends": "%s/%s",
  "compilerOptions": {
    "outDir": "./%s",
    "noEmit": false,
    "ignoreDeprecations": "6.0",
    "skipLibCheck": true,
    "baseUrl": ".",
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
import path from 'node:path';
import process from 'node:process';

const [node, tsc, ...args] = process.argv.slice(2);
const outDir = args[args.indexOf('--project') + 1]; // This is actually the tsconfig path, but we need outDir

// Run tsc
console.log('Running tsc...');
const tscResult = spawnSync(node, [tsc, ...args], { stdio: 'inherit' });
if (tscResult.status !== 0) {
    console.error('tsc failed with status', tscResult.status);
    process.exit(tscResult.status || 1);
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
    args.add(tsc_path)
    args.add("--project")
    args.add(ts_config_generated.path)

    all_inputs = depset(
        ctx.files.srcs + [ctx.file.tsconfig, ts_config_generated, tsc_file, wrapper_script],
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
