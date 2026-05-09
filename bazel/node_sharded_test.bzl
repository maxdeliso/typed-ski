"""Bazel rule for running Node.js sharded tests."""

load("//bazel:common.bzl", "shell_dquote_literal", "normalize_runfiles_path", "merge_target_runfiles")

def _node_sharded_test_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node_path = normalize_runfiles_path(node_toolchain.nodeinfo.node.short_path)

    extension = ".bat" if is_windows else ".sh"
    launcher = ctx.actions.declare_file(ctx.label.name + extension)

    thanatos_rootpath = ctx.expand_location(
        "$(rootpath %s)" % str(ctx.attr.thanatos.label),
        [ctx.attr.thanatos],
    )
    clang_rootpath = ""
    if ctx.attr.clang:
        clang_rootpath = ctx.expand_location(
            "$(rootpath %s)" % str(ctx.attr.clang.label),
            [ctx.attr.clang],
        )

    dist_files = {f.basename: f for f in ctx.attr.dist[DefaultInfo].files.to_list()}
    dist_bin_name = "tripc.cmd" if is_windows else "tripc"
    dist_js_rootpath = dist_files["tripc.js"].short_path
    dist_min_js_rootpath = dist_files["tripc.min.js"].short_path
    dist_node_js_rootpath = dist_files["tripc.node.js"].short_path
    dist_bin_rootpath = dist_files[dist_bin_name].short_path

    if is_windows:
        node_bin = node_path.replace("/", "\\")
        command = "\"%NODE_BIN%\" \"--experimental-transform-types\" \"--preserve-symlinks\" \"--preserve-symlinks-main\" \"scripts/bazel.ts\" \"bazel-test-shard\" %*"
        content_lines = [
            "@echo off",
            "setlocal",
            "if \"%TEST_SRCDIR%\"==\"\" (",
            "  echo TEST_SRCDIR is not set.",
            "  exit /b 1",
            ")",
            "if \"%TEST_WORKSPACE%\"==\"\" (",
            "  echo TEST_WORKSPACE is not set.",
            "  exit /b 1",
            ")",
            "set \"RUNFILES_ROOT=%TEST_SRCDIR%\\%TEST_WORKSPACE%\"",
            "set \"NODE_BIN=%TEST_SRCDIR%\\" + node_bin + "\"",
            "if not exist \"%RUNFILES_ROOT%\" (",
            "  echo RUNFILES_ROOT not found: %RUNFILES_ROOT%",
            "  exit /b 1",
            ")",
            "if not exist \"%NODE_BIN%\" (",
            "  echo NODE_BIN not found: %NODE_BIN%",
            "  exit /b 1",
            ")",
            "cd /d \"%RUNFILES_ROOT%\"",
            "if not exist \"scripts\\bazel.ts\" (",
            "  echo bazel.ts not found under %RUNFILES_ROOT%",
            "  exit /b 1",
            ")",
            "set \"THANATOS_BIN=%RUNFILES_ROOT%\\" + thanatos_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_JS_PATH=%RUNFILES_ROOT%\\" + dist_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_MIN_JS_PATH=%RUNFILES_ROOT%\\" + dist_min_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_NODE_JS_PATH=%RUNFILES_ROOT%\\" + dist_node_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_BIN_PATH=%RUNFILES_ROOT%\\" + dist_bin_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_READY=1\"",
        ]
        if clang_rootpath:
            content_lines.append("set \"TYPED_SKI_CLANG=%RUNFILES_ROOT%\\" + clang_rootpath.replace("/", "\\") + "\"")

        content_lines.extend([
            "if not \"%TEST_SHARD_STATUS_FILE%\"==\"\" type nul > \"%TEST_SHARD_STATUS_FILE%\"",
            command,
            "exit /b %ERRORLEVEL%",
            "",
        ])
        content = "\r\n".join(content_lines)
    else:
        node_bin = shell_dquote_literal(node_path)
        command = "\"$node_bin\" --experimental-transform-types --preserve-symlinks --preserve-symlinks-main scripts/bazel.ts bazel-test-shard \"$@\""
        content_lines = [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "if [[ -z \"${TEST_SRCDIR:-}\" ]]; then",
            "  echo \"TEST_SRCDIR is not set.\" >&2",
            "  exit 1",
            "fi",
            "if [[ -z \"${TEST_WORKSPACE:-}\" ]]; then",
            "  echo \"TEST_WORKSPACE is not set.\" >&2",
            "  exit 1",
            "fi",
            "runfiles_root=\"${TEST_SRCDIR}/${TEST_WORKSPACE}\"",
            "node_bin=\"${TEST_SRCDIR}/" + node_bin + "\"",
            "if [[ ! -d \"$runfiles_root\" ]]; then",
            "  echo \"RUNFILES_ROOT not found: $runfiles_root\" >&2",
            "  exit 1",
            "fi",
            "if [[ ! -f \"$node_bin\" ]]; then",
            "  echo \"NODE_BIN not found: $node_bin\" >&2",
            "  exit 1",
            "fi",
            "cd \"$runfiles_root\"",
            "if [[ ! -f \"scripts/bazel.ts\" ]]; then",
            "  echo \"bazel.ts not found under $runfiles_root\" >&2",
            "  exit 1",
            "fi",
            "export THANATOS_BIN=\"$runfiles_root/" + shell_dquote_literal(thanatos_rootpath) + "\"",
            "export TYPED_SKI_DIST_JS_PATH=\"$runfiles_root/" + shell_dquote_literal(dist_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_MIN_JS_PATH=\"$runfiles_root/" + shell_dquote_literal(dist_min_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_NODE_JS_PATH=\"$runfiles_root/" + shell_dquote_literal(dist_node_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_BIN_PATH=\"$runfiles_root/" + shell_dquote_literal(dist_bin_rootpath) + "\"",
            "export TYPED_SKI_DIST_READY=1",
        ]
        if clang_rootpath:
            content_lines.append("export TYPED_SKI_CLANG=\"$runfiles_root/" + shell_dquote_literal(clang_rootpath) + "\"")

        content_lines.extend([
            "[[ -n \"${TEST_SHARD_STATUS_FILE:-}\" ]] && touch \"$TEST_SHARD_STATUS_FILE\"",
            command,
            "",
        ])
        content = "\n".join(content_lines)

    ctx.actions.write(launcher, content, is_executable = True)

    symlinks = {}
    if ctx.file.generated_jsr:
        symlinks["jsr.json"] = ctx.file.generated_jsr

    runfiles_files = ctx.files.data + [ctx.executable.thanatos, node_toolchain.nodeinfo.node] + ctx.attr.dist[DefaultInfo].files.to_list() + ([ctx.file.generated_jsr] if ctx.file.generated_jsr else [])
    if ctx.attr.clang:
        runfiles_files.append(ctx.executable.clang)
    if ctx.attr.llvm_dist:
        runfiles_files.extend(ctx.files.llvm_dist)

    runfiles = ctx.runfiles(
        files = runfiles_files,
        symlinks = symlinks,
    )
    runfiles = merge_target_runfiles(runfiles, ctx.attr.data)
    runfiles = runfiles.merge(ctx.attr.thanatos[DefaultInfo].default_runfiles)
    runfiles = runfiles.merge(ctx.attr.dist[DefaultInfo].default_runfiles)
    if ctx.attr.clang:
        runfiles = runfiles.merge(ctx.attr.clang[DefaultInfo].default_runfiles)
        runfiles = runfiles.merge(ctx.attr.clang[DefaultInfo].data_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

node_sharded_test = rule(
    implementation = _node_sharded_test_impl,
    attrs = {
        "clang": attr.label(
            executable = True,
            cfg = "exec",
        ),
        "data": attr.label_list(
            allow_files = True,
        ),
        "dist": attr.label(
            mandatory = True,
        ),
        "generated_jsr": attr.label(
            allow_single_file = True,
        ),
        "llvm_dist": attr.label_list(
            allow_files = True,
            cfg = "exec",
        ),
        "thanatos": attr.label(
            executable = True,
            cfg = "target",
            mandatory = True,
        ),
        "_windows_constraint": attr.label(
            default = "@platforms//os:windows",
        ),
    },
    executable = True,
    test = True,
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
