"""Bazel rule implementation for generating Node distribution artifacts."""

load("//bazel:common.bzl", "shell_quote", "batch_quote")

def _find_esbuild_entry(files):
    for f in files:
        p = f.path.replace("\\", "/")
        if p.endswith("/esbuild/bin/esbuild"):
            return f.path
        if f.is_directory and p.endswith("/esbuild"):
            return f.path + "/bin/esbuild"
    fail("Cannot find esbuild/bin/esbuild in the esbuild attr")

def _node_dist_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node_path = node_toolchain.nodeinfo.target_tool_path

    ts_out_dir = ctx.attr.ts_out[DefaultInfo].files.to_list()[0]
    bazel_build_dist_js = ts_out_dir.path + "/scripts/bazelBuildDist.js"

    esbuild_entry = _find_esbuild_entry(ctx.files.esbuild)

    tripc_js = ctx.actions.declare_file(ctx.label.name + "/tripc.js")
    tripc_min_js = ctx.actions.declare_file(ctx.label.name + "/tripc.min.js")
    tripc_node_js = ctx.actions.declare_file(ctx.label.name + "/tripc.node.js")
    tripc_bin = ctx.actions.declare_file(
        ctx.label.name + ("/tripc.cmd" if is_windows else "/tripc"),
    )
    manifest = ctx.actions.declare_file(ctx.label.name + ".manifest")
    launcher = ctx.actions.declare_file(ctx.label.name + (".bat" if is_windows else ".sh"))

    manifest_lines = sorted(["%s\t%s" % (f.path, f.short_path) for f in ctx.files.data])
    ctx.actions.write(manifest, "\n".join(manifest_lines) + "\n")

    if is_windows:
        command = " ".join([
            batch_quote(node_path),
            batch_quote(bazel_build_dist_js),
            batch_quote(manifest.path),
            batch_quote(tripc_js.path),
            batch_quote(tripc_min_js.path),
            batch_quote(tripc_node_js.path),
            batch_quote(tripc_bin.path),
        ])
        content = "\r\n".join([
            "@echo off",
            "setlocal",
            "cd /d \"%CD%\"",
            "set \"TYPED_SKI_ESBUILD_PATH=%CD%\\" + esbuild_entry.replace("/", "\\") + "\"",
            command,
            "exit /b %ERRORLEVEL%",
            "",
        ])
    else:
        command = " ".join([
            shell_quote(node_path),
            shell_quote(bazel_build_dist_js),
            shell_quote(manifest.path),
            shell_quote(tripc_js.path),
            shell_quote(tripc_min_js.path),
            shell_quote(tripc_node_js.path),
            shell_quote(tripc_bin.path),
        ])
        content = "\n".join([
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "cd \"$PWD\"",
            "export TYPED_SKI_ESBUILD_PATH=\"$PWD/" + esbuild_entry + "\"",
            command,
            "",
        ])

    ctx.actions.write(launcher, content, is_executable = True)
    outputs = [tripc_js, tripc_min_js, tripc_node_js, tripc_bin]

    ctx.actions.run(
        executable = launcher,
        inputs = ctx.files.data + ctx.files.esbuild + [manifest, node_toolchain.nodeinfo.node, ts_out_dir],
        outputs = outputs,
        mnemonic = "NodeDist",
        progress_message = "Building Node dist artifacts for %s" % ctx.label,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset(outputs))]

node_dist = rule(
    implementation = _node_dist_impl,
    attrs = {
        "data": attr.label_list(
            allow_files = True,
        ),
        "esbuild": attr.label_list(
            allow_files = True,
            mandatory = True,
        ),
        "ts_out": attr.label(
            mandatory = True,
        ),
        "_windows_constraint": attr.label(
            default = "@platforms//os:windows",
        ),
    },
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
