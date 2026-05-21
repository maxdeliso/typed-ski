"""Hermetic Prettier format check, run as a sandboxed Bazel action.

Prettier and Node both come from Bazel (npm_translate_lock and the
rules_nodejs toolchain), so this needs no host pnpm or node_modules.
"""

# Extensions Prettier has a built-in parser for. Files in srcs with any
# other extension (.trip, .bzl, ...) are skipped, matching `prettier .`.
_PRETTIER_EXTENSIONS = [
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".jsonc",
    ".md",
    ".yml",
    ".yaml",
]

def _is_formattable(f):
    if f.is_directory:
        return False
    for ext in _PRETTIER_EXTENSIONS:
        if f.path.endswith(ext):
            return True
    return False

def _prettier_check_impl(ctx):
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node = node_toolchain.nodeinfo.node

    prettier_path = None
    for f in ctx.files.node_modules:
        p = f.path.replace("\\", "/")
        if p.endswith("/prettier/bin/prettier.cjs"):
            prettier_path = f.path
            break
        if f.is_directory and p.endswith("/prettier"):
            prettier_path = f.path + "/bin/prettier.cjs"
            break
    if prettier_path == None:
        fail("Cannot find prettier/bin/prettier.cjs in node_modules")

    check_files = [f for f in ctx.files.srcs if _is_formattable(f)]
    if not check_files:
        fail("prettier_check: srcs contains no Prettier-formattable files")

    file_list = ctx.actions.declare_file(ctx.label.name + "_files.txt")
    ctx.actions.write(file_list, "\n".join([f.path for f in check_files]) + "\n")

    marker = ctx.actions.declare_file(ctx.label.name + ".passed")
    wrapper = ctx.actions.declare_file(ctx.label.name + "_run.mjs")

    # Batches keep each prettier argv well under the Windows command-line
    # limit; the source files themselves are staged as action inputs.
    ctx.actions.write(wrapper, """\
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const [node, prettier, fileList, marker] = process.argv.slice(2);
const files = readFileSync(fileList, "utf8").split("\\n").filter(Boolean);
const BATCH = 120;
for (let i = 0; i < files.length; i += BATCH) {
  const result = spawnSync(
    node,
    [prettier, "--check", ...files.slice(i, i + BATCH)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
writeFileSync(marker, "ok\\n");
""")

    args = ctx.actions.args()
    args.add(wrapper.path)
    args.add(node.path)
    args.add(prettier_path)
    args.add(file_list.path)
    args.add(marker.path)

    ctx.actions.run(
        executable = node,
        arguments = [args],
        inputs = depset(
            check_files + [file_list, wrapper],
            transitive = [depset(ctx.files.node_modules)],
        ),
        outputs = [marker],
        mnemonic = "PrettierCheck",
        progress_message = "Checking formatting with Prettier for %s" % ctx.label,
        use_default_shell_env = True,
    )
    return [DefaultInfo(files = depset([marker]))]

prettier_check = rule(
    implementation = _prettier_check_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True),
        "node_modules": attr.label_list(allow_files = True),
    },
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
